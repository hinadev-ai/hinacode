import { randomBytes, randomUUID } from "node:crypto"
import { Cause, Clock, Context, Cron, Effect, FiberHandle, Layer, Option, Schema, Stream } from "effect"
import { SqlClient, SqlError, SqlSchema } from "effect/sql"
import { ProviderId } from "../../../shared/agent.ts"
import type { RoutineInput } from "../../../shared/contract.ts"
import {
  isThreadBusy,
  type Routine,
  RoutineRun,
  type RoutineRunSource,
  type RoutineRunStatus,
  RoutineSchedule,
  RoutineWorkspace,
  type Settings as SettingsValue,
  type Thread,
  Timestamp,
  type WorkspaceChoice,
} from "../../../shared/domain.ts"
import { AgentRunner } from "../AgentRunner.ts"
import { nowIso } from "../clock.ts"
import { NotFoundError, type PersistenceError, persistence } from "../errors.ts"
import { Events } from "../Events.ts"
import { Projects } from "../Projects.ts"
import { Scheduler } from "../Scheduler.ts"
import { Secrets } from "../Secrets.ts"
import { Settings } from "../Settings.ts"
import { Threads } from "../Threads.ts"
import { Worktrees } from "../Worktrees.ts"
import { hookPath, webhookServer } from "./webhook.ts"

export const WEBHOOK_SECRET = "routines.webhookSecret"
export const AUTO_PAUSE_FAILURES = 3
export const MAX_ROUTINES = 100

export class RoutineError extends Schema.TaggedError<RoutineError>()("RoutineError", {
  reason: Schema.String,
}) {
  override get message(): string {
    return this.reason
  }
}

export interface UpdateRoutine extends Partial<Omit<RoutineInput, "projectId">> {
  readonly id: string
}

type Failure = PersistenceError | NotFoundError | RoutineError

export class Routines extends Context.Service<
  Routines,
  {
    readonly list: Effect.Effect<ReadonlyArray<Routine>, PersistenceError>
    readonly get: (id: string) => Effect.Effect<Routine, PersistenceError | NotFoundError>
    readonly create: (input: RoutineInput) => Effect.Effect<Routine, Failure>
    readonly update: (input: UpdateRoutine) => Effect.Effect<Routine, Failure>
    readonly remove: (id: string) => Effect.Effect<void, PersistenceError>
    readonly run: (
      id: string,
      source: RoutineRunSource,
      payload: string | null,
      eventKey?: string | null,
    ) => Effect.Effect<RoutineRun, PersistenceError | NotFoundError>
    readonly runs: (id: string, limit: number) => Effect.Effect<ReadonlyArray<RoutineRun>, PersistenceError>
    readonly webhook: (
      id: string,
    ) => Effect.Effect<{ url: string; hasSecret: boolean; listenError: string | null }, Failure>
    readonly rotateWebhookSecret: Effect.Effect<{ secret: string }, PersistenceError>
  }
>()("hinacode/Routines") {}

const RoutineRow = Schema.Struct({
  id: Schema.String,
  projectId: Schema.String,
  name: Schema.String,
  enabled: Schema.BooleanFromBit,
  prompt: Schema.String,
  provider: ProviderId,
  model: Schema.String,
  effort: Schema.NullOr(Schema.String),
  workspace: RoutineWorkspace,
  schedule: Schema.NullOr(Schema.fromJsonString(RoutineSchedule)),
  nextRunAt: Schema.NullOr(Timestamp),
  createdAt: Timestamp,
  updatedAt: Timestamp,
})
type RoutineRow = typeof RoutineRow.Type

const RUN_COLUMNS = "id, routine_id, thread_id, source, status, error, created_at"

const isUniqueViolation = (cause: unknown) => SqlError.isSqlError(cause) && cause.reason._tag === "UniqueViolation"

// FIXME: Effect's ServeError has an empty message and keeps the real error in `cause`
const describeError = (error: unknown): string => {
  if (!(error instanceof Error)) return String(error)
  if (error.message === "" && error.cause !== undefined) return describeError(error.cause)
  return error.message
}

const describeCause = (cause: Cause.Cause<unknown>) => describeError(Cause.squash(cause))

const prettyJson = (text: string) => {
  try {
    return JSON.stringify(JSON.parse(text), null, 2)
  } catch {
    return undefined
  }
}

const fenced = (body: string) => {
  const json = prettyJson(body)
  const text = json ?? body
  const longestBackticks = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length))
  const fence = "`".repeat(Math.max(3, longestBackticks + 1))
  return `${fence}${json === undefined ? "" : "json"}\n${text}\n${fence}`
}

export const promptWithPayload = (prompt: string, payload: string | null) =>
  payload === null ? prompt : `${prompt}\n\n${fenced(payload)}`

const isUnrepliedRun = (thread: Thread) =>
  thread.status === "idle" && thread.settledAt === null && thread.pinnedAt === null

const cronOf = (schedule: RoutineSchedule) => Cron.parseUnsafe(schedule.cron, schedule.timezone)

const nextRunAfter = (row: Pick<RoutineRow, "enabled" | "schedule">, now: number) =>
  row.enabled && row.schedule !== null ? Cron.next(cronOf(row.schedule), now).toISOString() : null

const sameSchedule = (a: RoutineSchedule | null, b: RoutineSchedule | null) =>
  a === b || (a !== null && b !== null && a.cron === b.cron && a.timezone === b.timezone)

const validate = (input: Pick<RoutineInput, "name" | "model" | "prompt">) => {
  if (input.name.trim() === "") return Effect.fail(new RoutineError({ reason: "Name is required" }))
  if (input.model.trim() === "") return Effect.fail(new RoutineError({ reason: "Model is required" }))
  if (input.prompt.trim() === "") return Effect.fail(new RoutineError({ reason: "Prompt is required" }))
  return Effect.void
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const threads = yield* Threads
  const worktrees = yield* Worktrees
  const projects = yield* Projects
  const settings = yield* Settings
  const secrets = yield* Secrets
  const runner = yield* AgentRunner
  const events = yield* Events
  const scheduler = yield* Scheduler
  const scope = yield* Effect.scope

  const encodeRow = Schema.encodeEffect(RoutineRow)

  const findRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: RoutineRow,
    execute: () => sql`SELECT * FROM routine WHERE ${sql.in("provider", [...ProviderId.literals])} ORDER BY created_at`,
  })
  const findRow = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: RoutineRow,
    execute: (id) => sql`SELECT * FROM routine WHERE id = ${id}`,
  })
  const findLatestRuns = SqlSchema.findAll({
    Request: Schema.Void,
    Result: RoutineRun,
    execute: () => sql`
      SELECT ${sql.literal(RUN_COLUMNS)} FROM routine_run r
      WHERE created_at = (SELECT MAX(created_at) FROM routine_run WHERE routine_id = r.routine_id)
    `,
  })
  const findRuns = SqlSchema.findAll({
    Request: Schema.Struct({ id: Schema.String, limit: Schema.Number }),
    Result: RoutineRun,
    execute: ({ id, limit }) => sql`
      SELECT ${sql.literal(RUN_COLUMNS)} FROM routine_run
      WHERE routine_id = ${id} ORDER BY created_at DESC, rowid DESC LIMIT ${limit}
    `,
  })
  const findRun = SqlSchema.findOne({
    Request: Schema.String,
    Result: RoutineRun,
    execute: (id) => sql`SELECT ${sql.literal(RUN_COLUMNS)} FROM routine_run WHERE id = ${id}`,
  })
  const findLastStartedThread = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: Schema.Struct({ threadId: Schema.String }),
    execute: (id) => sql`
      SELECT thread_id FROM routine_run
      WHERE routine_id = ${id} AND status = 'started' AND thread_id IS NOT NULL
      ORDER BY created_at DESC, rowid DESC LIMIT 1
    `,
  })
  const findScheduledOutcomes = SqlSchema.findAll({
    Request: Schema.String,
    Result: Schema.Struct({ status: Schema.String }),
    execute: (id) => sql`
      SELECT status FROM routine_run
      WHERE routine_id = ${id} AND source = 'schedule' AND status != 'skipped'
      ORDER BY created_at DESC, rowid DESC LIMIT ${AUTO_PAUSE_FAILURES}
    `,
  })

  const withLastRun = (row: RoutineRow, latest: ReadonlyArray<RoutineRun>): Routine => ({
    ...row,
    lastRun: latest.find((run) => run.routineId === row.id) ?? null,
  })

  const getRow = (id: string) =>
    findRow(id).pipe(
      Effect.mapError(persistence("routines.get")),
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(new NotFoundError({ entity: "routine", id })),
          onSome: Effect.succeed,
        }),
      ),
    )

  const get = (id: string) =>
    Effect.gen(function* () {
      const row = yield* getRow(id)
      const runs = yield* findRuns({ id, limit: 1 }).pipe(Effect.mapError(persistence("routines.get")))
      return withLastRun(row, runs)
    })

  const list = Effect.gen(function* () {
    const rows = yield* findRows(undefined)
    const latest = yield* findLatestRuns(undefined)
    return rows.map((row) => withLastRun(row, latest))
  }).pipe(Effect.mapError(persistence("routines.list")))

  const publishRun = (runId: string) =>
    findRun(runId).pipe(Effect.tap((run) => events.publish({ type: "routine.run", run })))

  const insertRun = (run: {
    readonly routineId: string
    readonly source: RoutineRunSource
    readonly eventKey: string | null
    readonly payload: string | null
    readonly status: RoutineRunStatus
    readonly error?: string | undefined
  }) =>
    Effect.gen(function* () {
      const id = randomUUID()
      yield* sql`INSERT INTO routine_run ${sql.insert({
        id,
        routineId: run.routineId,
        threadId: null,
        source: run.source,
        eventKey: run.eventKey,
        payload: run.payload,
        status: run.status,
        error: run.error ?? null,
        createdAt: yield* nowIso,
      })}`
      return id
    })

  const workspaceFor = (routine: RoutineRow) =>
    Effect.gen(function* () {
      const project = yield* projects.get(routine.projectId)
      if (project.kind !== "folder") return undefined
      const ref = yield* worktrees.currentBranch(routine.projectId)
      return { mode: routine.workspace, target: { _tag: "branch", ref } } satisfies WorkspaceChoice
    })

  const findUnrepliedRuns = SqlSchema.findAll({
    Request: Schema.Struct({ createdBy: Schema.String, latest: Schema.String }),
    Result: Schema.Struct({ id: Schema.String }),
    execute: ({ createdBy, latest }) => sql`
      SELECT id FROM thread t
      WHERE created_by = ${createdBy} AND id != ${latest} AND status = 'idle'
        AND settled_at IS NULL AND pinned_at IS NULL
        AND (SELECT COUNT(*) FROM message WHERE thread_id = t.id AND role = 'user') = 1
    `,
  })

  const settleEarlierRuns = (routine: RoutineRow, latest: string) =>
    Effect.gen(function* () {
      const earlier = yield* findUnrepliedRuns({ createdBy: `routine:${routine.id}`, latest })
      yield* Effect.forEach(
        earlier,
        ({ id }) =>
          threads.settleIf(id, isUnrepliedRun).pipe(
            Effect.flatMap(
              Option.match({
                onNone: () => Effect.void,
                onSome: (thread) => events.publish({ type: "thread.updated", thread }),
              }),
            ),
          ),
        { discard: true },
      )
    }).pipe(Effect.catchCause((cause) => Effect.logWarning("could not settle earlier routine runs", routine.id, cause)))

  const createThread = (routine: RoutineRow, runId: string) =>
    Effect.gen(function* () {
      const workspace = yield* workspaceFor(routine)
      const thread = yield* threads.create({
        projectId: routine.projectId,
        title: `${routine.name} ${runId.slice(0, 5)}`,
        provider: routine.provider,
        model: routine.model,
        effort: routine.effort,
        createdBy: `routine:${routine.id}`,
      })
      yield* events.publish({ type: "thread.updated", thread })
      yield* sql`UPDATE routine_run SET thread_id = ${thread.id} WHERE id = ${runId}`
      yield* settleEarlierRuns(routine, thread.id)
      return { thread, workspace }
    })

  const recordSkip = (routine: RoutineRow, source: RoutineRunSource, eventKey: string | null, error: string) =>
    insertRun({ routineId: routine.id, source, eventKey, payload: null, status: "skipped", error }).pipe(
      Effect.flatMap(publishRun),
    )

  const pauseAfterRepeatedFailures = (routine: RoutineRow) =>
    Effect.gen(function* () {
      const outcomes = yield* findScheduledOutcomes(routine.id)
      if (outcomes.length < AUTO_PAUSE_FAILURES || outcomes.some(({ status }) => status !== "failed")) return
      const now = yield* nowIso
      yield* sql`UPDATE routine SET enabled = 0, next_run_at = NULL, updated_at = ${now} WHERE id = ${routine.id}`
      yield* Effect.logWarning("routine paused after repeated failures", routine.id)
      yield* events.publish({ type: "routines.changed" })
      yield* Effect.forkIn(scheduler.remove(routine.id), scope)
    })

  const markFailed = (routine: RoutineRow, source: RoutineRunSource, runId: string, cause: Cause.Cause<unknown>) =>
    Effect.gen(function* () {
      yield* sql`UPDATE routine_run SET status = 'failed', error = ${describeCause(cause)} WHERE id = ${runId}`
      yield* Effect.logWarning("routine run failed", routine.id, cause)
      yield* publishRun(runId)
      if (source === "schedule") yield* pauseAfterRepeatedFailures(routine)
    })

  const startRun = (routine: RoutineRow, source: RoutineRunSource, payload: string | null, eventKey: string | null) =>
    Effect.gen(function* () {
      const claimed = yield* insertRun({ routineId: routine.id, source, eventKey, payload, status: "started" }).pipe(
        Effect.map(Option.some),
        Effect.catchIf(isUniqueViolation, () => Effect.succeedNone),
      )
      if (Option.isNone(claimed)) return yield* recordSkip(routine, source, null, `Already ran for ${eventKey}`)
      const runId = claimed.value
      const created = yield* createThread(routine, runId).pipe(
        Effect.map(Option.some),
        Effect.catchCause((cause) => Effect.as(markFailed(routine, source, runId, cause), Option.none())),
      )
      if (Option.isNone(created)) return yield* findRun(runId)
      const { thread, workspace } = created.value
      yield* runner.send(thread.id, promptWithPayload(routine.prompt, payload), [], { workspace }).pipe(
        Effect.catchCause((cause) => markFailed(routine, source, runId, cause)),
        Effect.catchCause((cause) => Effect.logError("could not record a failed routine run", routine.id, cause)),
        Effect.forkIn(scope),
      )
      return yield* publishRun(runId)
    }).pipe(Effect.uninterruptible, Effect.mapError(persistence("routines.run")))

  const previousThreadBusy = (id: string) =>
    Effect.gen(function* () {
      const last = yield* findLastStartedThread(id)
      if (Option.isNone(last)) return false
      return yield* threads.get(last.value.threadId).pipe(
        Effect.map((thread) => isThreadBusy(thread.status)),
        Effect.catchTag("NotFoundError", () => Effect.succeed(false)),
      )
    })

  const runScheduled = (id: string, dueAt: Date, nextAt: Date) =>
    Effect.gen(function* () {
      const next = nextAt.toISOString()
      const claimed = yield* sql`
        UPDATE routine SET next_run_at = ${next} WHERE id = ${id} AND next_run_at = ${dueAt.toISOString()} RETURNING id
      `
      if (claimed.length === 0) return
      const routine = yield* getRow(id)
      if (yield* previousThreadBusy(id)) {
        yield* recordSkip(routine, "schedule", null, "The previous run is still working or waiting for you")
        return
      }
      yield* startRun(routine, "schedule", null, null)
    }).pipe(
      Effect.uninterruptible,
      Effect.catchCause((cause) => Effect.logError("scheduled routine failed", id, cause)),
    )

  const sync = (row: RoutineRow) => {
    if (!row.enabled || row.schedule === null || row.nextRunAt === null) return scheduler.remove(row.id)
    return scheduler.put({
      id: row.id,
      cron: cronOf(row.schedule),
      nextRunAt: new Date(row.nextRunAt),
      run: (dueAt, nextAt) => runScheduled(row.id, dueAt, nextAt),
    })
  }

  const listener = yield* FiberHandle.make()
  let listenError: string | null = null

  const webhookSecret = secrets.get(WEBHOOK_SECRET).pipe(
    Effect.map(Option.getOrUndefined),
    Effect.catch((error) => Effect.as(Effect.logError("could not read the routine webhook secret", error), undefined)),
  )

  const listen = (address: SettingsValue["routines"]) =>
    Effect.gen(function* () {
      listenError = null
      const server = webhookServer(
        { host: address.bindHost, port: address.port },
        {
          secret: webhookSecret,
          enabled: (id) =>
            findRow(id).pipe(
              Effect.map(Option.match({ onNone: () => undefined, onSome: (routine) => routine.enabled })),
              Effect.orDie,
            ),
          deliver: (id, body, eventKey) =>
            getRow(id).pipe(
              Effect.flatMap((routine) => startRun(routine, "webhook", body, eventKey)),
              Effect.orDie,
            ),
        },
      )
      yield* Effect.logInfo("routine webhooks listening", `${address.bindHost}:${address.port}`)
      yield* events.publish({ type: "routines.changed" })
      yield* FiberHandle.run(
        listener,
        Layer.launch(server).pipe(
          Effect.catchCause((cause) => {
            listenError = describeCause(cause)
            return Effect.logWarning("routine webhook listener failed", listenError).pipe(
              Effect.andThen(events.publish({ type: "routines.changed" })),
            )
          }),
        ),
      )
    })

  let address = (yield* settings.get).routines
  yield* listen(address)
  yield* (yield* settings.changes).pipe(
    Stream.runForEach((next) => {
      if (next.routines.bindHost === address.bindHost && next.routines.port === address.port) return Effect.void
      address = next.routines
      return listen(address)
    }),
    Effect.forkScoped,
  )

  const resume = Effect.gen(function* () {
    const rows = yield* findRows(undefined)
    const now = yield* Clock.currentTimeMillis
    yield* Effect.forEach(
      rows,
      (row) =>
        Effect.gen(function* () {
          if (!row.enabled || row.schedule === null || row.nextRunAt !== null) return yield* sync(row)
          const nextRunAt = nextRunAfter(row, now)
          yield* sql`UPDATE routine SET next_run_at = ${nextRunAt} WHERE id = ${row.id}`
          yield* sync({ ...row, nextRunAt })
        }),
      { discard: true },
    )
  })
  yield* resume.pipe(Effect.catch((error) => Effect.logError("could not schedule routines", error)))

  const write = (row: RoutineRow, operation: string) => encodeRow(row).pipe(Effect.mapError(persistence(operation)))

  const create = (input: RoutineInput) =>
    Effect.gen(function* () {
      yield* validate(input)
      yield* projects.get(input.projectId)
      const [existing] = yield* sql<{ readonly count: number }>`SELECT COUNT(*) AS count FROM routine`.pipe(
        Effect.mapError(persistence("routines.create")),
      )
      if ((existing?.count ?? 0) >= MAX_ROUTINES) {
        return yield* new RoutineError({
          reason: `This machine already has ${MAX_ROUTINES} routines. Delete one to add another.`,
        })
      }
      const now = yield* Clock.currentTimeMillis
      const createdAt = new Date(now).toISOString()
      const row: RoutineRow = {
        ...input,
        id: randomUUID(),
        name: input.name.trim(),
        model: input.model.trim(),
        nextRunAt: nextRunAfter(input, now),
        createdAt,
        updatedAt: createdAt,
      }
      const encoded = yield* write(row, "routines.create")
      yield* sql`INSERT INTO routine ${sql.insert(encoded)}`.pipe(Effect.mapError(persistence("routines.create")))
      yield* sync(row)
      yield* events.publish({ type: "routines.changed" })
      return withLastRun(row, [])
    })

  const update = ({ id, ...patch }: UpdateRoutine) =>
    Effect.gen(function* () {
      const current = yield* getRow(id)
      const definedPatch = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined))
      const now = yield* Clock.currentTimeMillis
      const merged: RoutineRow = { ...current, ...definedPatch, updatedAt: new Date(now).toISOString() }
      yield* validate(merged)
      const timingChanged = merged.enabled !== current.enabled || !sameSchedule(merged.schedule, current.schedule)
      const next: RoutineRow = timingChanged ? { ...merged, nextRunAt: nextRunAfter(merged, now) } : merged
      const encoded = yield* write(next, "routines.update")
      yield* sql`
        UPDATE routine
        SET name = ${encoded.name}, enabled = ${encoded.enabled}, prompt = ${encoded.prompt},
            provider = ${encoded.provider}, model = ${encoded.model}, effort = ${encoded.effort},
            workspace = ${encoded.workspace}, schedule = ${encoded.schedule}, next_run_at = ${encoded.nextRunAt},
            updated_at = ${encoded.updatedAt}
        WHERE id = ${id}
      `.pipe(Effect.mapError(persistence("routines.update")))
      if (timingChanged) yield* sync(next)
      yield* events.publish({ type: "routines.changed" })
      return yield* get(id)
    })

  const remove = (id: string) =>
    Effect.gen(function* () {
      yield* scheduler.remove(id)
      yield* sql`DELETE FROM routine WHERE id = ${id}`.pipe(Effect.mapError(persistence("routines.delete")))
      yield* events.publish({ type: "routines.changed" })
    })

  const run = (id: string, source: RoutineRunSource, payload: string | null, eventKey: string | null = null) =>
    Effect.flatMap(getRow(id), (routine) => startRun(routine, source, payload, eventKey))

  const webhook = (id: string) =>
    Effect.gen(function* () {
      yield* getRow(id)
      const secret = yield* secrets.get(WEBHOOK_SECRET)
      const host = address.bindHost
      const url = new URL(hookPath(id), `http://${host.includes(":") ? `[${host}]` : host}:${address.port}`)
      return { url: url.toString(), hasSecret: Option.isSome(secret), listenError }
    })

  const rotateWebhookSecret = Effect.gen(function* () {
    const secret = randomBytes(32).toString("hex")
    yield* secrets.set(WEBHOOK_SECRET, secret)
    return { secret }
  })

  return Routines.of({
    list,
    get,
    create,
    update,
    remove,
    run,
    runs: (id, limit) => findRuns({ id, limit }).pipe(Effect.mapError(persistence("routines.runs"))),
    webhook,
    rotateWebhookSecret,
  })
})

export const layer = Layer.effect(Routines, make)
