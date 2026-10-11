import { randomBytes, randomUUID } from "node:crypto"
import { hostname } from "node:os"
import { LinearClient, PaginationOrderBy } from "@linear/sdk"
import { Cause, Context, Effect, FiberHandle, FiberMap, Layer, Option, Random, Schema, Stream } from "effect"
import { SqlClient, SqlError, SqlSchema } from "effect/sql"
import { ProviderId } from "../../../shared/agent.ts"
import type { AutomationInput } from "../../../shared/contract.ts"
import {
  type Automation,
  AutomationRun,
  AutomationTrigger,
  type AutomationRunStatus,
  type Settings as SettingsValue,
  Timestamp,
} from "../../../shared/domain.ts"
import { LINEAR_API_KEY_SECRET } from "../../mcp/index.ts"
import { AgentRunner } from "../AgentRunner.ts"
import { nowIso } from "../clock.ts"
import { NotFoundError, type PersistenceError, persistence } from "../errors.ts"
import { Events } from "../Events.ts"
import { Git } from "../Git.ts"
import { Projects } from "../Projects.ts"
import { Secrets } from "../Secrets.ts"
import { Settings } from "../Settings.ts"
import { Threads } from "../Threads.ts"
import { Worktrees } from "../Worktrees.ts"
import {
  initialCursor,
  PollError,
  pollGithubIssues,
  pollLinearIssues,
  pollSlackMentions,
  type PollResult,
} from "./pollers.ts"
import { renderTemplate, slugifyBranch, titleFromPrompt } from "./template.ts"
import { hookPath, webhookServer } from "./webhook.ts"

export const SLACK_TOKEN_SECRET = "slack.token"
const webhookSecretName = (automationId: string) => `automation.${automationId}.webhookSecret`

const POLL_INTERVAL_MS = 60_000
const POLL_JITTER_MS = 10_000

export class AutomationError extends Schema.TaggedError<AutomationError>()("AutomationError", {
  reason: Schema.String,
}) {
  override get message(): string {
    return this.reason
  }
}

export interface UpdateAutomation extends Partial<Omit<AutomationInput, "projectId">> {
  readonly id: string
}

type Failure = PersistenceError | NotFoundError | AutomationError

export class Automations extends Context.Service<
  Automations,
  {
    readonly list: Effect.Effect<ReadonlyArray<Automation>, PersistenceError>
    readonly get: (id: string) => Effect.Effect<Automation, PersistenceError | NotFoundError>
    /** `secret` is the webhook HMAC secret; this is the only time it leaves the main process. */
    readonly create: (
      input: AutomationInput,
    ) => Effect.Effect<{ automation: Automation; secret: string | null }, Failure>
    readonly update: (input: UpdateAutomation) => Effect.Effect<Automation, Failure>
    readonly remove: (id: string) => Effect.Effect<void, PersistenceError>
    /** Runs the automation with `payload` as the template context, outside dedup. */
    readonly runNow: (id: string, payload: unknown) => Effect.Effect<AutomationRun, PersistenceError | NotFoundError>
    readonly runs: (id: string, limit: number) => Effect.Effect<ReadonlyArray<AutomationRun>, PersistenceError>
    readonly webhookUrl: (id: string) => Effect.Effect<{ url: string; listenError: string | null }, Failure>
  }
>()("kkcode/Automations") {}

/** The automation table row; `lastRun` is joined in separately. */
const AutomationRow = Schema.Struct({
  id: Schema.String,
  projectId: Schema.String,
  name: Schema.String,
  enabled: Schema.BooleanFromBit,
  trigger: Schema.fromJsonString(AutomationTrigger),
  promptTemplate: Schema.String,
  provider: ProviderId,
  model: Schema.String,
  runInWorktree: Schema.BooleanFromBit,
  branchTemplate: Schema.NullOr(Schema.String),
  cursor: Schema.NullOr(Schema.String),
  polledAt: Schema.NullOr(Timestamp),
  createdAt: Timestamp,
  updatedAt: Timestamp,
})
type AutomationRow = typeof AutomationRow.Type

const RUN_COLUMNS = "id, automation_id, thread_id, event_key, status, error, created_at"

const isUniqueViolation = (cause: unknown) => SqlError.isSqlError(cause) && cause.reason._tag === "UniqueViolation"

/** The innermost useful message: wrappers such as ServeError carry an empty one and the real error as `cause`. */
const describeError = (error: unknown): string => {
  if (!(error instanceof Error)) return String(error)
  if (error.message === "" && error.cause !== undefined) return describeError(error.cause)
  return error.message
}

const describeCause = (cause: Cause.Cause<unknown>) => describeError(Cause.squash(cause))

const REPO = /^[\w.-]+\/[\w.-]+$/

const validate = (input: Pick<AutomationInput, "name" | "model" | "trigger" | "promptTemplate">) => {
  if (input.name.trim() === "") return Effect.fail(new AutomationError({ reason: "Name is required" }))
  if (input.model.trim() === "") return Effect.fail(new AutomationError({ reason: "Model is required" }))
  if (input.promptTemplate.trim() === "") {
    return Effect.fail(new AutomationError({ reason: "Prompt template is required" }))
  }
  const { trigger } = input
  if (trigger.type === "github.issue" && !REPO.test(trigger.repo)) {
    return Effect.fail(new AutomationError({ reason: `Repository must be owner/name, got "${trigger.repo}"` }))
  }
  if (trigger.type === "linear.issue" && trigger.teamKey.trim() === "") {
    return Effect.fail(new AutomationError({ reason: "Linear team key is required" }))
  }
  if (trigger.type === "slack.mention" && trigger.botUserId.trim() === "") {
    return Effect.fail(new AutomationError({ reason: "Slack bot user id is required" }))
  }
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
  const git = yield* Git

  const encodeRow = Schema.encodeEffect(AutomationRow)
  const encodePayload = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))

  const findRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: AutomationRow,
    execute: () => sql`SELECT * FROM automation ORDER BY created_at`,
  })
  const findRow = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: AutomationRow,
    execute: (id) => sql`SELECT * FROM automation WHERE id = ${id}`,
  })
  const findLatestRuns = SqlSchema.findAll({
    Request: Schema.Void,
    Result: AutomationRun,
    execute: () => sql`
      SELECT ${sql.literal(RUN_COLUMNS)} FROM automation_run r
      WHERE created_at = (SELECT MAX(created_at) FROM automation_run WHERE automation_id = r.automation_id)
    `,
  })
  const findRuns = SqlSchema.findAll({
    Request: Schema.Struct({ id: Schema.String, limit: Schema.Number }),
    Result: AutomationRun,
    execute: ({ id, limit }) => sql`
      SELECT ${sql.literal(RUN_COLUMNS)} FROM automation_run
      WHERE automation_id = ${id} ORDER BY created_at DESC LIMIT ${limit}
    `,
  })
  const findRun = SqlSchema.findOne({
    Request: Schema.String,
    Result: AutomationRun,
    execute: (id) => sql`SELECT ${sql.literal(RUN_COLUMNS)} FROM automation_run WHERE id = ${id}`,
  })

  const withLastRun = (row: AutomationRow, latest: ReadonlyArray<AutomationRun>): Automation => ({
    ...row,
    lastRun: latest.find((run) => run.automationId === row.id) ?? null,
  })

  const getRow = (id: string) =>
    findRow(id).pipe(
      Effect.mapError(persistence("automations.get")),
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(new NotFoundError({ entity: "automation", id })),
          onSome: Effect.succeed,
        }),
      ),
    )

  const get = (id: string) =>
    Effect.gen(function* () {
      const row = yield* getRow(id)
      const runs = yield* findRuns({ id, limit: 1 }).pipe(Effect.mapError(persistence("automations.get")))
      return withLastRun(row, runs)
    })

  const list = Effect.gen(function* () {
    const rows = yield* findRows(undefined)
    const latest = yield* findLatestRuns(undefined)
    return rows.map((row) => withLastRun(row, latest))
  }).pipe(Effect.mapError(persistence("automations.list")))

  // Runs

  const publishRun = (runId: string) =>
    findRun(runId).pipe(
      Effect.flatMap((run) => Effect.as(events.publish({ type: "automation.run", run }), run)),
      Effect.mapError(persistence("automations.publishRun")),
    )

  const insertRun = (run: {
    readonly automationId: string
    readonly eventKey: string | null
    readonly payload: unknown
    readonly status: AutomationRunStatus
    readonly error?: string | undefined
  }) =>
    Effect.gen(function* () {
      const id = randomUUID()
      yield* sql`INSERT INTO automation_run ${sql.insert({
        id,
        automationId: run.automationId,
        threadId: null,
        eventKey: run.eventKey,
        payload: yield* encodePayload(run.payload),
        status: run.status,
        error: run.error ?? null,
        createdAt: yield* nowIso,
      })}`
      return id
    })

  const branchFor = (automation: AutomationRow, payload: unknown, runId: string) => {
    const fallback = `kk/${slugifyBranch(automation.name) || "automation"}-${runId.slice(0, 6)}`
    if (automation.branchTemplate === null) return fallback
    return slugifyBranch(renderTemplate(automation.branchTemplate, payload)) || fallback
  }

  const startThread = (automation: AutomationRow, payload: unknown, runId: string) =>
    Effect.gen(function* () {
      const prompt = renderTemplate(automation.promptTemplate, payload)
      if (prompt.trim() === "") {
        return yield* new AutomationError({ reason: "The prompt template rendered to an empty prompt" })
      }
      const worktree = automation.runInWorktree
        ? {
            branch: branchFor(automation, payload, runId),
            baseRef: yield* worktrees.currentBranch(automation.projectId),
          }
        : undefined
      const thread = yield* threads.create({
        projectId: automation.projectId,
        title: titleFromPrompt(prompt, automation.name),
        provider: automation.provider,
        model: automation.model,
        worktree,
        createdBy: `automation:${automation.id}`,
      })
      yield* events.publish({ type: "thread.updated", thread })
      yield* sql`UPDATE automation_run SET thread_id = ${thread.id} WHERE id = ${runId}`
      yield* runner.send(thread.id, prompt, [])
    })

  /**
   * Starts a thread for one event. Never fails: a duplicate `eventKey` records a skipped run and
   * any error records a failed run, both pushed to the renderer like a started one.
   */
  const startRun = (automation: AutomationRow, eventKey: string, payload: unknown) =>
    Effect.gen(function* () {
      const claimed = yield* insertRun({ automationId: automation.id, eventKey, payload, status: "started" }).pipe(
        Effect.map(Option.some),
        Effect.catchIf(isUniqueViolation, () => Effect.succeedNone),
      )
      if (Option.isNone(claimed)) {
        const skipped = yield* insertRun({ automationId: automation.id, eventKey, payload, status: "skipped" })
        return yield* publishRun(skipped)
      }
      const runId = claimed.value
      yield* startThread(automation, payload, runId).pipe(
        Effect.catchCause((cause) =>
          sql`
            UPDATE automation_run SET status = 'failed', error = ${describeCause(cause)} WHERE id = ${runId}
          `.pipe(Effect.andThen(Effect.logWarning("automation run failed", automation.id, cause))),
        ),
      )
      return yield* publishRun(runId)
    }).pipe(Effect.mapError(persistence("automations.trigger")))

  // Polling

  const pollSource = (automation: AutomationRow, cursor: string): Effect.Effect<PollResult, PollError | Failure> => {
    const { trigger } = automation
    switch (trigger.type) {
      case "webhook":
        return Effect.fail(new PollError({ reason: "Webhook automations are not polled" }))
      case "github.issue":
        return Effect.flatMap(projects.get(automation.projectId), (project) =>
          pollGithubIssues((args) => git.gh(project.rootPath, args), trigger, cursor),
        )
      case "linear.issue":
        return Effect.flatMap(secrets.get(LINEAR_API_KEY_SECRET), (apiKey) => {
          if (Option.isNone(apiKey)) {
            return Effect.fail(new PollError({ reason: "No Linear API key. Add one in Settings > Integrations." }))
          }
          const client = new LinearClient({ apiKey: apiKey.value })
          return pollLinearIssues(
            async (filter) => (await client.issues({ filter, first: 50, orderBy: PaginationOrderBy.CreatedAt })).nodes,
            trigger,
            cursor,
          )
        })
      case "slack.mention":
        return Effect.flatMap(secrets.get(SLACK_TOKEN_SECRET), (token) =>
          Option.isNone(token)
            ? Effect.fail(new PollError({ reason: "No Slack user token. Add one in Settings > Integrations." }))
            : pollSlackMentions(fetch, token.value, trigger, cursor),
        )
    }
  }

  const savePollState = (id: string, cursor: string) =>
    Effect.flatMap(
      nowIso,
      (now) => sql`UPDATE automation SET cursor = ${cursor}, polled_at = ${now} WHERE id = ${id}`,
    ).pipe(Effect.mapError(persistence("automations.savePollState")))

  /** Records a poll failure as a failed run, unless the latest run already reports the same error. */
  const recordPollFailure = (id: string, error: string) =>
    Effect.gen(function* () {
      yield* Effect.flatMap(nowIso, (now) => sql`UPDATE automation SET polled_at = ${now} WHERE id = ${id}`)
      const [latest] = yield* findRuns({ id, limit: 1 })
      if (latest?.status === "failed" && latest.eventKey === null && latest.error === error) return
      const runId = yield* insertRun({ automationId: id, eventKey: null, payload: null, status: "failed", error })
      yield* publishRun(runId)
    })

  const pollOnce = (id: string) =>
    Effect.gen(function* () {
      const automation = yield* getRow(id)
      if (automation.cursor === null) {
        // First poll of a new automation: start from now instead of replaying old events.
        return yield* savePollState(id, initialCursor(automation.trigger, new Date()))
      }
      const { events: polled, cursor } = yield* pollSource(automation, automation.cursor)
      yield* Effect.forEach(polled, (event) => startRun(automation, event.key, event.payload), { discard: true })
      yield* savePollState(id, cursor)
    }).pipe(
      Effect.catchCause((cause) =>
        recordPollFailure(id, describeCause(cause)).pipe(
          Effect.catchCause((recordCause) => Effect.logError("automation poll failed", id, cause, recordCause)),
        ),
      ),
    )

  const pollLoop = (id: string) =>
    Effect.gen(function* () {
      yield* Effect.sleep(yield* Random.nextIntBetween(0, POLL_JITTER_MS))
      while (true) {
        yield* pollOnce(id)
        yield* Effect.sleep(POLL_INTERVAL_MS + (yield* Random.nextIntBetween(-POLL_JITTER_MS, POLL_JITTER_MS)))
      }
    })

  const pollers = yield* FiberMap.make<string>()

  /** Starts, restarts or stops the automation's poll fiber to match its current config. */
  const supervise = (automation: AutomationRow) =>
    automation.enabled && automation.trigger.type !== "webhook"
      ? Effect.asVoid(FiberMap.run(pollers, automation.id, pollLoop(automation.id)))
      : FiberMap.remove(pollers, automation.id)

  // Webhook listener

  const listener = yield* FiberHandle.make()
  let listenError: string | null = null

  const webhookTarget = (id: string) =>
    Effect.gen(function* () {
      const automation = yield* getRow(id)
      if (automation.trigger.type !== "webhook") return undefined
      const secret = yield* secrets.get(webhookSecretName(id))
      if (Option.isNone(secret)) return undefined
      return { secret: secret.value, enabled: automation.enabled }
    }).pipe(
      Effect.catchTag("NotFoundError", () => Effect.succeed(undefined)),
      Effect.orDie,
    )

  const listen = (address: SettingsValue["automations"]) =>
    Effect.gen(function* () {
      listenError = null
      const server = webhookServer(
        { host: address.bindHost, port: address.port },
        {
          target: webhookTarget,
          deliver: (id, eventKey, payload) =>
            getRow(id).pipe(
              Effect.flatMap((automation) => startRun(automation, eventKey, payload)),
              Effect.orDie,
            ),
        },
      )
      yield* Effect.logInfo("automation webhooks listening", `${address.bindHost}:${address.port}`)
      yield* FiberHandle.run(
        listener,
        Layer.launch(server).pipe(
          Effect.catchCause((cause) => {
            listenError = describeCause(cause)
            return Effect.logWarning("automation webhook listener failed", cause)
          }),
        ),
      )
    })

  // Startup: converge the poll fibers and the listener on what the database and settings say.

  const initial = yield* settings.get
  let address = initial.automations
  yield* listen(address)
  yield* settings.changes.pipe(
    Stream.runForEach((next) => {
      if (next.automations.bindHost === address.bindHost && next.automations.port === address.port) {
        return Effect.void
      }
      address = next.automations
      return listen(address)
    }),
    Effect.forkScoped,
  )
  yield* Effect.flatMap(findRows(undefined), (rows) => Effect.forEach(rows, supervise, { discard: true })).pipe(
    Effect.catch((error) => Effect.logError("could not start automation pollers", error)),
  )

  // Commands

  const create = (input: AutomationInput) =>
    Effect.gen(function* () {
      yield* validate(input)
      yield* projects.get(input.projectId)
      const now = yield* nowIso
      const row: AutomationRow = {
        ...input,
        name: input.name.trim(),
        model: input.model.trim(),
        id: randomUUID(),
        cursor: null,
        polledAt: null,
        createdAt: now,
        updatedAt: now,
      }
      const secret = row.trigger.type === "webhook" ? randomBytes(32).toString("hex") : null
      if (secret !== null) yield* secrets.set(webhookSecretName(row.id), secret)
      const encoded = yield* encodeRow(row).pipe(Effect.mapError(persistence("automations.create")))
      yield* sql`INSERT INTO automation ${sql.insert(encoded)}`.pipe(Effect.mapError(persistence("automations.create")))
      yield* supervise(row)
      return { automation: withLastRun(row, []), secret }
    })

  const update = ({ id, ...patch }: UpdateAutomation) =>
    Effect.gen(function* () {
      const current = yield* getRow(id)
      if (patch.trigger && patch.trigger.type !== current.trigger.type) {
        return yield* new AutomationError({
          reason: "The trigger type cannot change. Create a new automation instead.",
        })
      }
      const definedPatch = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined))
      const next: AutomationRow = { ...current, ...definedPatch, updatedAt: yield* nowIso }
      yield* validate(next)
      const encoded = yield* encodeRow(next).pipe(Effect.mapError(persistence("automations.update")))
      yield* sql`
        UPDATE automation
        SET name = ${encoded.name}, enabled = ${encoded.enabled}, trigger = ${encoded.trigger},
            prompt_template = ${encoded.promptTemplate}, provider = ${encoded.provider}, model = ${encoded.model},
            run_in_worktree = ${encoded.runInWorktree}, branch_template = ${encoded.branchTemplate},
            updated_at = ${encoded.updatedAt}
        WHERE id = ${id}
      `.pipe(Effect.mapError(persistence("automations.update")))
      yield* supervise(next)
      return yield* get(id)
    })

  const remove = (id: string) =>
    Effect.gen(function* () {
      yield* FiberMap.remove(pollers, id)
      yield* sql`DELETE FROM automation WHERE id = ${id}`.pipe(Effect.mapError(persistence("automations.delete")))
      yield* secrets.clear(webhookSecretName(id))
    })

  const runNow = (id: string, payload: unknown) =>
    Effect.flatMap(getRow(id), (automation) => startRun(automation, `manual:${randomUUID()}`, payload))

  const webhookUrl = (id: string) =>
    Effect.gen(function* () {
      const automation = yield* getRow(id)
      if (automation.trigger.type !== "webhook") {
        return yield* new AutomationError({ reason: `${automation.name} is not a webhook automation` })
      }
      const wildcard = address.bindHost === "0.0.0.0" || address.bindHost === "::"
      const host = wildcard ? hostname() : address.bindHost
      const url = new URL(hookPath(id), `http://${host.includes(":") ? `[${host}]` : host}:${address.port}`)
      return { url: url.toString(), listenError }
    })

  return Automations.of({
    list,
    get,
    create,
    update,
    remove,
    runNow,
    runs: (id, limit) => findRuns({ id, limit }).pipe(Effect.mapError(persistence("automations.runs"))),
    webhookUrl,
  })
})

export const layer = Layer.effect(Automations, make)
