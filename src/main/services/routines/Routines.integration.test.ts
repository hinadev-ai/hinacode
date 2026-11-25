import { createHmac } from "node:crypto"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "@effect/vitest"
import { Cron, Deferred, Effect, Stream } from "effect"
import { SqlClient } from "effect/sql"
import type { AgentEvent } from "../../../shared/agent.ts"
import type { RoutineTrigger } from "../../../shared/domain.ts"
import type { AgentProvider } from "../../agents/provider.ts"
import * as AgentRunner from "../AgentRunner.ts"
import * as Secrets from "../Secrets.ts"
import * as Settings from "../Settings.ts"
import type { Job } from "../Scheduler.ts"
import * as Threads from "../Threads.ts"
import { MAX_ROUTINES, Routines, WEBHOOK_SECRET } from "./Routines.ts"
import { finished, provider, repo, settled, userTexts, withApp } from "./testing.ts"
import { type Arrival, FOLLOW_UP } from "./triggers.ts"

const hourly = { cron: "0 * * * *", timezone: "UTC" }

const createRoutine = (
  projectId: string,
  overrides: {
    enabled?: boolean
    schedule?: typeof hourly | null
    workspace?: "local" | "worktree"
    trigger?: RoutineTrigger | null
  } = {},
) =>
  Routines.use((routines) =>
    routines.create({
      projectId,
      name: "Morning triage",
      enabled: overrides.enabled ?? true,
      prompt: "Triage the inbox",
      provider: "claude",
      model: "test-model",
      effort: null,
      workspace: overrides.workspace ?? "local",
      schedule: overrides.schedule === undefined ? hourly : overrides.schedule,
      trigger: overrides.trigger ?? null,
    }),
  )

const runsOf = (id: string) => Routines.use((routines) => routines.runs(id, 20))

const fireDueSlot = (jobs: Map<string, Job>, id: string) =>
  Effect.gen(function* () {
    const job = jobs.get(id)
    if (job === undefined) return yield* Effect.die(`no job for ${id}`)
    const { nextRunAt } = yield* Routines.use((routines) => routines.get(id))
    if (nextRunAt === null) return yield* Effect.die(`${id} has no next run`)
    const dueAt = new Date(nextRunAt)
    yield* job.run(dueAt, Cron.next(job.cron, dueAt))
    return dueAt
  })

const settledAt = (id: string) =>
  Threads.Threads.use((threads) => threads.get(id)).pipe(Effect.map((thread) => thread.settledAt))

const withWorktree = (threadId: string | null) =>
  Threads.Threads.use((threads) => threads.get(threadId ?? "")).pipe(
    Effect.repeat({ until: (thread) => thread.worktreeId !== null }),
  )

describe("routine scheduling", () => {
  it.effect("create, disable and enable move nextRunAt and the scheduler job", () =>
    withApp(({ projectId, jobs }) =>
      Effect.gen(function* () {
        const routine = yield* createRoutine(projectId)
        expect(routine.nextRunAt).toBe("1970-01-01T01:00:00.000Z")
        expect(jobs.has(routine.id)).toBe(true)

        const disabled = yield* Routines.use((routines) => routines.update({ id: routine.id, enabled: false }))
        expect(disabled.nextRunAt).toBeNull()
        expect(jobs.has(routine.id)).toBe(false)

        const enabled = yield* Routines.use((routines) => routines.update({ id: routine.id, enabled: true }))
        expect(enabled.nextRunAt).toBe("1970-01-01T01:00:00.000Z")
        expect(jobs.has(routine.id)).toBe(true)

        const unscheduled = yield* Routines.use((routines) => routines.update({ id: routine.id, schedule: null }))
        expect(unscheduled.nextRunAt).toBeNull()
        expect(jobs.has(routine.id)).toBe(false)

        const manual = yield* createRoutine(projectId, { schedule: null })
        expect(manual.nextRunAt).toBeNull()
        expect(jobs.has(manual.id)).toBe(false)
      }),
    ),
  )

  it.effect("rejects an empty name or prompt and an unknown project", () =>
    withApp(({ projectId }) =>
      Effect.gen(function* () {
        const routine = yield* createRoutine(projectId)
        const empty = yield* Effect.flip(Routines.use((routines) => routines.update({ id: routine.id, prompt: " " })))
        expect(empty.message).toBe("Prompt is required")
        const missing = yield* Effect.flip(createRoutine("nope"))
        expect(missing._tag).toBe("NotFoundError")
      }),
    ),
  )

  it.effect("runs a routine without a model on the agent's default model at run time", () =>
    withApp(({ projectId }) =>
      Effect.gen(function* () {
        const routine = yield* Routines.use((routines) =>
          routines.create({
            projectId,
            name: "Nightly sweep",
            enabled: true,
            prompt: "Sweep",
            provider: "claude",
            model: "",
            effort: null,
            workspace: "local",
            schedule: null,
            trigger: null,
          }),
        )
        expect(routine.model).toBe("")
        yield* Settings.Settings.use((settings) => settings.set({ defaultModel: { claude: "provider-default" } }))

        const run = yield* Routines.use((routines) => routines.run(routine.id, "manual", null))
        const thread = yield* settled(run.threadId)
        expect(thread.model).toBe("provider-default")
      }),
    ),
  )

  it.effect("refuses a routine past the per-machine limit", () =>
    withApp(({ projectId }) =>
      Effect.gen(function* () {
        yield* Effect.forEach(Array.from({ length: MAX_ROUTINES }), () => createRoutine(projectId, { schedule: null }))
        const full = yield* Effect.flip(createRoutine(projectId, { schedule: null }))
        expect(full.message).toContain(`${MAX_ROUTINES} routines`)
        const routines = yield* Routines.use((routines) => routines.list)
        expect(routines).toHaveLength(MAX_ROUTINES)
      }),
    ),
  )

  it.effect("starts one thread for a claimed slot, however often the slot fires", () =>
    withApp(({ projectId, jobs, pushes }) =>
      Effect.gen(function* () {
        const routine = yield* createRoutine(projectId)
        const dueAt = yield* fireDueSlot(jobs, routine.id)
        const job = jobs.get(routine.id)!
        yield* job.run(dueAt, Cron.next(job.cron, dueAt))

        const runs = yield* runsOf(routine.id)
        expect(runs.map((run) => [run.source, run.status])).toStrictEqual([["schedule", "started"]])
        const thread = yield* settled(runs[0]!.threadId)
        expect(thread.createdBy).toBe(`routine:${routine.id}`)
        expect(thread.title).toMatch(/^Morning triage \w{5}$/)
        expect(pushes.some((event) => event.type === "routine.run" && event.run.id === runs[0]!.id)).toBe(true)
      }),
    ),
  )

  it.effect("gives every worktree run its own worktree", () =>
    withApp(({ projectId }) =>
      Effect.gen(function* () {
        const routine = yield* createRoutine(projectId, { schedule: null, workspace: "worktree" })
        const first = yield* Routines.use((routines) => routines.run(routine.id, "manual", null))
        const second = yield* Routines.use((routines) => routines.run(routine.id, "manual", null))
        const threads = [yield* withWorktree(first.threadId), yield* withWorktree(second.threadId)]
        expect(threads[0]!.worktreeId).not.toBe(threads[1]!.worktreeId)
        const runs = yield* runsOf(routine.id)
        expect(runs.map((run) => run.status)).toStrictEqual(["started", "started"])
      }),
    ),
  )

  it.effect("settles earlier runs nobody replied to, so the inbox holds one run per routine", () =>
    withApp(({ projectId, pushes }) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const routine = yield* createRoutine(projectId, { schedule: null })
        const run = () => Routines.use((routines) => routines.run(routine.id, "manual", null))
        const first = yield* finished((yield* run()).threadId)
        const replied = yield* finished((yield* run()).threadId)
        yield* sql`INSERT INTO message (id, thread_id, role, parts, created_at) VALUES ('reply', ${replied.id}, 'user', '[]', '1970-01-01T00:00:00.000Z')`
        const latest = yield* finished((yield* run()).threadId)

        expect(yield* settledAt(first.id)).not.toBeNull()
        expect(yield* settledAt(replied.id)).toBeNull()
        expect(yield* settledAt(latest.id)).toBeNull()
        expect(
          pushes.some(
            (event) =>
              event.type === "thread.updated" && event.thread.id === first.id && event.thread.settledAt !== null,
          ),
        ).toBe(true)
      }),
    ),
  )

  it.effect("skips a scheduled run while the previous thread is busy, but not a manual one", () =>
    withApp(({ projectId, jobs }) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const routine = yield* createRoutine(projectId)
        yield* fireDueSlot(jobs, routine.id)
        const [first] = yield* runsOf(routine.id)
        yield* settled(first!.threadId)
        yield* sql`UPDATE thread SET status = 'running' WHERE id = ${first!.threadId}`

        yield* fireDueSlot(jobs, routine.id)
        const [skipped] = yield* runsOf(routine.id)
        expect(skipped).toMatchObject({ source: "schedule", status: "skipped", threadId: null })
        expect(skipped!.error).toContain("previous run")

        const manual = yield* Routines.use((routines) => routines.run(routine.id, "manual", null))
        expect(manual).toMatchObject({ source: "manual", status: "started" })
      }),
    ),
  )

  it.effect("pauses a routine after three scheduled failures in a row", () =>
    withApp(({ projectId, jobs }) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const routine = yield* createRoutine(projectId)
        yield* sql`UPDATE project SET root_path = ${join(repo, "missing")} WHERE id = ${projectId}`

        yield* fireDueSlot(jobs, routine.id)
        yield* fireDueSlot(jobs, routine.id)
        expect((yield* Routines.use((routines) => routines.get(routine.id))).enabled).toBe(true)
        yield* fireDueSlot(jobs, routine.id)

        const paused = yield* Routines.use((routines) => routines.get(routine.id))
        expect(paused).toMatchObject({ enabled: false, nextRunAt: null })
        expect((yield* runsOf(routine.id)).map((run) => run.status)).toStrictEqual(["failed", "failed", "failed"])
        yield* Effect.yieldNow
        expect(jobs.has(routine.id)).toBe(false)
      }),
    ),
  )
})

const onComments: RoutineTrigger = {
  event: "github.issue_comment",
  fromUsers: ["octocat"],
  scopes: ["acme/api"],
  contains: null,
  continuation: "conversation",
}

const comment = (id: number, overrides: Partial<Arrival> = {}): Arrival => ({
  event: "github.issue_comment",
  key: `github:comment:${id}`,
  sender: "octocat",
  scope: "acme/api",
  text: `Comment number ${id}`,
  conversation: "github:acme/api#12",
  destination: { source: "github", repo: "acme/api", number: 12, url: "https://github.com/acme/api/issues/12" },
  context: { kind: "issue", title: "Broken", body: "It broke", author: "someone" },
  ...overrides,
})

const arrive = (arrival: Arrival) => Routines.use((routines) => routines.arrive(arrival))

const triggered = (projectId: string, trigger: Partial<RoutineTrigger> = {}, enabled = true) =>
  createRoutine(projectId, { schedule: null, enabled, trigger: { ...onComments, ...trigger } })

const runOf = (routineId: string, runId: string, until: (status: string) => boolean) =>
  runsOf(routineId).pipe(
    Effect.map((runs) => runs.find((run) => run.id === runId)),
    Effect.repeat({ until: (run) => run !== undefined && until(run.status) }),
  )

describe("routine triggers", () => {
  it.effect("keeps a routine's trigger through create, update and get", () =>
    withApp(({ projectId }) =>
      Effect.gen(function* () {
        const routine = yield* triggered(projectId)
        expect(routine.trigger).toStrictEqual(onComments)
        const changed = { ...onComments, contains: "@hina", continuation: "new" as const }
        yield* Routines.use((routines) => routines.update({ id: routine.id, trigger: changed }))
        expect((yield* Routines.use((routines) => routines.get(routine.id))).trigger).toStrictEqual(changed)
        yield* Routines.use((routines) => routines.update({ id: routine.id, trigger: null }))
        expect((yield* Routines.use((routines) => routines.list))[0]?.trigger).toBeNull()
      }),
    ),
  )

  it.effect("starts one thread with the routine prompt and the quoted event, once per event", () =>
    withApp(({ projectId }) =>
      Effect.gen(function* () {
        const routine = yield* triggered(projectId)
        const [run] = yield* arrive(comment(1))
        expect(run).toMatchObject({ source: "event", status: "started" })
        const [first] = yield* userTexts(run!.threadId, 1)
        expect(first).toMatch(/^Triage the inbox\n\n```json\n/)
        expect(first).toContain('"text": "Comment number 1"')
        expect(first).toContain('"from": "octocat"')

        const [again] = yield* arrive(comment(1))
        expect(again).toMatchObject({ status: "skipped", threadId: null })
        const runs = yield* runsOf(routine.id)
        expect(runs.map((each) => each.status)).toStrictEqual(["skipped", "started"])
        expect(yield* userTexts(run!.threadId, 1)).toHaveLength(1)
      }),
    ),
  )

  it.effect("ignores a stranger, another repository and text without the phrase", () =>
    withApp(({ projectId }) =>
      Effect.gen(function* () {
        const routine = yield* triggered(projectId, { contains: "@hina" })
        expect(yield* arrive(comment(1, { sender: "stranger", text: "@hina go" }))).toStrictEqual([])
        expect(yield* arrive(comment(2, { scope: "acme/web", text: "@hina go" }))).toStrictEqual([])
        expect(yield* arrive(comment(3, { text: "go" }))).toStrictEqual([])
        expect(yield* runsOf(routine.id)).toStrictEqual([])
      }),
    ),
  )

  it.effect("a disabled routine starts nothing", () =>
    withApp(({ projectId }) =>
      Effect.gen(function* () {
        const routine = yield* triggered(projectId, {}, false)
        expect(yield* arrive(comment(1))).toStrictEqual([])
        expect(yield* runsOf(routine.id)).toStrictEqual([])
      }),
    ),
  )

  it.effect("hands a later event in the same conversation to the same thread", () =>
    withApp(({ projectId }) =>
      Effect.gen(function* () {
        const routine = yield* triggered(projectId)
        const [first] = yield* arrive(comment(1))
        yield* finished(first!.threadId)
        const [second] = yield* arrive(comment(2))
        expect(second).toMatchObject({ source: "event", status: "started", threadId: first!.threadId })

        const texts = yield* userTexts(first!.threadId, 2)
        expect(texts[1]).toContain(FOLLOW_UP)
        expect(texts[1]).toContain('"text": "Comment number 2"')
        expect(texts[1]).not.toContain("Comment number 1")
        expect(texts[1]).not.toContain("Triage the inbox")
        const runs = yield* runsOf(routine.id)
        expect(runs.map((run) => [run.status, run.threadId])).toStrictEqual([
          ["started", first!.threadId],
          ["started", first!.threadId],
        ])
      }),
    ),
  )

  it.effect("keeps two events that arrive together in one conversation on one thread", () =>
    withApp(({ projectId }) =>
      Effect.gen(function* () {
        yield* triggered(projectId)
        const [[first], [second]] = yield* Effect.all([arrive(comment(1)), arrive(comment(2))], {
          concurrency: "unbounded",
        })

        expect(first!.threadId).not.toBeNull()
        expect(second!.threadId).toBe(first!.threadId)
        expect(yield* userTexts(first!.threadId, 2)).toHaveLength(2)
      }),
    ),
  )

  it.effect("starts a new thread with the routine prompt after a conversation's thread failed to start", () =>
    withApp(({ projectId }) =>
      Effect.gen(function* () {
        const routine = yield* createRoutine(projectId, {
          schedule: null,
          workspace: "worktree",
          trigger: onComments,
        })
        const blocker = join(mkdtempSync(join(tmpdir(), "kk-routines-blocker-")), "file")
        writeFileSync(blocker, "")
        yield* Settings.Settings.use((settings) => settings.set({ worktreeRoot: join(blocker, "worktrees") }))
        const [first] = yield* arrive(comment(1))
        yield* runOf(routine.id, first!.id, (status) => status === "failed")

        yield* Settings.Settings.use((settings) => settings.set({ worktreeRoot: null }))
        const [second] = yield* arrive(comment(2))
        expect(second).toMatchObject({ status: "started" })
        expect(second!.threadId).not.toBe(first!.threadId)
        const [prompt] = yield* userTexts(second!.threadId, 1)
        expect(prompt).toMatch(/^Triage the inbox/)
        expect(prompt).toContain('"text": "Comment number 2"')
      }),
    ),
  )

  it.effect("does not count an event run as the previous scheduled run", () =>
    withApp(({ projectId, jobs }) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const routine = yield* createRoutine(projectId, { trigger: onComments })
        yield* fireDueSlot(jobs, routine.id)
        const [scheduled] = yield* runsOf(routine.id)
        yield* finished(scheduled!.threadId)
        const [event] = yield* arrive(comment(1))
        yield* finished(event!.threadId)
        yield* sql`UPDATE thread SET status = 'running' WHERE id = ${scheduled!.threadId}`

        yield* fireDueSlot(jobs, routine.id)
        const [skipped] = yield* runsOf(routine.id)
        expect(skipped).toMatchObject({ source: "schedule", status: "skipped", threadId: null })
      }),
    ),
  )

  it.effect("leaves an idle conversation's thread unsettled when a manual run starts", () =>
    withApp(({ projectId }) =>
      Effect.gen(function* () {
        const routine = yield* triggered(projectId)
        const [event] = yield* arrive(comment(1))
        const conversation = yield* finished(event!.threadId)
        const run = () => Routines.use((routines) => routines.run(routine.id, "manual", null))
        const earlier = yield* finished((yield* run()).threadId)
        yield* finished((yield* run()).threadId)

        expect(yield* settledAt(earlier.id)).not.toBeNull()
        expect(yield* settledAt(conversation.id)).toBeNull()
      }),
    ),
  )

  it.effect("starts a thread per event when the routine asks for new threads", () =>
    withApp(({ projectId }) =>
      Effect.gen(function* () {
        yield* triggered(projectId, { continuation: "new" })
        const [first] = yield* arrive(comment(1))
        yield* finished(first!.threadId)
        const [second] = yield* arrive(comment(2))
        expect(second!.threadId).not.toBeNull()
        expect(second!.threadId).not.toBe(first!.threadId)
        expect(yield* userTexts(second!.threadId, 1)).toHaveLength(1)
      }),
    ),
  )

  it.effect("starts a new thread once the conversation's thread is archived", () =>
    withApp(({ projectId }) =>
      Effect.gen(function* () {
        yield* triggered(projectId)
        const [first] = yield* arrive(comment(1))
        yield* finished(first!.threadId)
        yield* Threads.Threads.use((threads) => threads.archive(first!.threadId!))
        const [second] = yield* arrive(comment(2))
        expect(second).toMatchObject({ status: "started" })
        expect(second!.threadId).not.toBe(first!.threadId)
        const [prompt] = yield* userTexts(second!.threadId, 1)
        expect(prompt).toMatch(/^Triage the inbox/)
      }),
    ),
  )

  it.effect("gives every matching routine its own thread", () =>
    withApp(({ projectId }) =>
      Effect.gen(function* () {
        const one = yield* triggered(projectId)
        const two = yield* triggered(projectId)
        const runs = yield* arrive(comment(1))
        expect(runs.map((run) => [run.routineId, run.status]).toSorted()).toStrictEqual(
          [
            [one.id, "started"],
            [two.id, "started"],
          ].toSorted(),
        )
        expect(runs[0]!.threadId).not.toBe(runs[1]!.threadId)
      }),
    ),
  )

  const turnHeld = {
    started: Deferred.makeUnsafe<void>(),
    steered: Deferred.makeUnsafe<void>(),
    release: Deferred.makeUnsafe<void>(),
  }
  const holdingProvider: AgentProvider = {
    ...provider("claude"),
    runTurn: () =>
      Stream.fromEffect(
        Deferred.succeed(turnHeld.started, undefined).pipe(Effect.andThen(Deferred.await(turnHeld.release))),
      ).pipe(Stream.as<AgentEvent>({ type: "turn_completed" })),
    steer: () => Deferred.succeed(turnHeld.steered, undefined).pipe(Effect.as(false)),
  }

  it.effect("skips a later event when the routine is disabled before the thread takes it", () =>
    withApp(
      ({ projectId }) =>
        Effect.gen(function* () {
          const routine = yield* triggered(projectId)
          const [first] = yield* arrive(comment(1))
          yield* Deferred.await(turnHeld.started)
          const [second] = yield* arrive(comment(2))
          yield* Deferred.await(turnHeld.steered)
          yield* Routines.use((routines) => routines.update({ id: routine.id, enabled: false }))
          yield* Deferred.succeed(turnHeld.release, undefined)

          const skipped = yield* runOf(routine.id, second!.id, (status) => status !== "started")
          expect(skipped).toMatchObject({ status: "skipped", error: "The thread did not take the event" })
          yield* settled(first!.threadId)
          expect(yield* userTexts(first!.threadId, 1)).toHaveLength(1)
        }),
      holdingProvider,
    ),
  )
})

const post = (port: number, id: string, init: { body?: string; headers?: Record<string, string> } = {}) =>
  Effect.tryPromise(() =>
    fetch(`http://127.0.0.1:${port}/hooks/routines/${id}`, { method: "POST", ...init }).then(async (response) => ({
      status: response.status,
      body: (await response.json()) as Record<string, unknown>,
    })),
  ).pipe(Effect.retry({ times: 100 }))

const sign = (secret: string, body: string) => `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`

const issueComment = JSON.stringify({
  action: "created",
  issue: {
    id: 1,
    number: 12,
    title: "Broken",
    body: "It broke",
    html_url: "https://github.com/acme/api/issues/12",
    user: { login: "someone" },
  },
  comment: { id: 77, body: "Please look" },
  repository: { full_name: "acme/api" },
  sender: { login: "octocat", type: "User" },
})

const postGitHub = (port: number, event: string, body: string, headers: Record<string, string> = {}) =>
  Effect.tryPromise(() =>
    fetch(`http://127.0.0.1:${port}/hooks/github`, {
      method: "POST",
      body,
      headers: { "x-github-event": event, ...headers },
    }).then(async (response) => ({
      status: response.status,
      body: (await response.json()) as Record<string, unknown>,
    })),
  ).pipe(Effect.retry({ times: 100 }))

describe("routine webhook", () => {
  it.live("refuses a body over 1 MB without starting a run", () =>
    withApp(({ projectId, port }) =>
      Effect.gen(function* () {
        const routine = yield* createRoutine(projectId, { schedule: null })
        const { secret } = yield* Routines.use((routines) => routines.rotateWebhookSecret)
        const oversized = yield* post(port, routine.id, {
          body: "x".repeat(1024 * 1024 + 1),
          headers: { authorization: `Bearer ${secret}` },
        })
        expect(oversized.status).toBe(413)
        expect(yield* Routines.use((routines) => routines.runs(routine.id, 10))).toHaveLength(0)
      }),
    ),
  )

  it.live("authenticates with a bearer secret or an HMAC and appends the body to the prompt", () =>
    withApp(({ projectId, port }) =>
      Effect.gen(function* () {
        const routine = yield* createRoutine(projectId, { schedule: null })
        const before = yield* Routines.use((routines) => routines.webhook(routine.id))
        expect(before).toMatchObject({ hasSecret: false, listenError: null })
        expect(before.url).toBe(`http://127.0.0.1:${port}/hooks/routines/${routine.id}`)

        expect((yield* post(port, routine.id)).status).toBe(401)
        const { secret } = yield* Routines.use((routines) => routines.rotateWebhookSecret)
        expect((yield* Routines.use((routines) => routines.webhook(routine.id))).hasSecret).toBe(true)
        expect((yield* post(port, routine.id, { headers: { authorization: "Bearer wrong" } })).status).toBe(401)
        expect((yield* post(port, routine.id, { headers: { "x-hub-signature-256": sign("wrong", "") } })).status).toBe(
          401,
        )
        expect((yield* post(port, "unknown", { headers: { authorization: `Bearer ${secret}` } })).status).toBe(404)

        const body = JSON.stringify({ ref: "main" })
        const bearer = yield* post(port, routine.id, { body, headers: { authorization: `Bearer ${secret}` } })
        expect(bearer.status).toBe(202)
        const transcript = yield* AgentRunner.AgentRunner.use((runner) =>
          runner.transcript(String(bearer.body["threadId"])),
        ).pipe(Effect.repeat({ until: (stored) => stored.messages.length > 0 }))
        expect(transcript.messages[0]?.parts).toStrictEqual([
          { type: "text", text: 'Triage the inbox\n\n```json\n{\n  "ref": "main"\n}\n```' },
        ])

        const hmac = yield* post(port, routine.id, { body, headers: { "x-hub-signature-256": sign(secret, body) } })
        expect(hmac.status).toBe(202)
        expect((yield* runsOf(routine.id)).map((run) => [run.source, run.status])).toStrictEqual([
          ["webhook", "started"],
          ["webhook", "started"],
        ])
      }),
    ),
  )

  it.live("answers 409 for a disabled routine and dedupes retries by idempotency key", () =>
    withApp(({ projectId, port }) =>
      Effect.gen(function* () {
        yield* Secrets.Secrets.use((secrets) => secrets.set(WEBHOOK_SECRET, "s3cret"))
        const routine = yield* createRoutine(projectId, { enabled: false, schedule: null })
        const auth = { authorization: "Bearer s3cret" }
        expect((yield* post(port, routine.id, { headers: auth })).status).toBe(409)

        yield* Routines.use((routines) => routines.update({ id: routine.id, enabled: true }))
        const headers = { ...auth, "idempotency-key": "delivery-1" }
        expect((yield* post(port, routine.id, { headers })).status).toBe(202)
        const retry = yield* post(port, routine.id, { headers })
        expect(retry.status).toBe(200)
        expect(retry.body["skipped"]).toBe(true)
        expect((yield* runsOf(routine.id)).map((run) => run.status)).toStrictEqual(["skipped", "started"])
      }),
    ),
  )

  it.live("takes GitHub deliveries only with a valid signature", () =>
    withApp(({ projectId, port }) =>
      Effect.gen(function* () {
        const routine = yield* triggered(projectId)
        const github = yield* Routines.use((routines) => routines.webhook(routine.id))
        expect(github.githubUrl).toBe(`http://127.0.0.1:${port}/hooks/github`)

        const signed = { "x-hub-signature-256": sign("s3cret", issueComment) }
        expect((yield* postGitHub(port, "issue_comment", issueComment, signed)).status).toBe(401)
        yield* Secrets.Secrets.use((secrets) => secrets.set(WEBHOOK_SECRET, "s3cret"))
        expect((yield* postGitHub(port, "issue_comment", issueComment)).status).toBe(401)
        const wrong = { "x-hub-signature-256": sign("wrong", issueComment) }
        expect((yield* postGitHub(port, "issue_comment", issueComment, wrong)).status).toBe(401)
        const bearer = { authorization: "Bearer s3cret" }
        expect((yield* postGitHub(port, "issue_comment", issueComment, bearer)).status).toBe(401)
        const notJson = "not json"
        expect(
          (yield* postGitHub(port, "issue_comment", notJson, { "x-hub-signature-256": sign("s3cret", notJson) }))
            .status,
        ).toBe(400)
        expect(yield* runsOf(routine.id)).toStrictEqual([])
      }),
    ),
  )

  it.live("answers a ping without starting anything and starts a run for a signed comment", () =>
    withApp(({ projectId, port }) =>
      Effect.gen(function* () {
        yield* Secrets.Secrets.use((secrets) => secrets.set(WEBHOOK_SECRET, "s3cret"))
        const routine = yield* triggered(projectId)
        const ping = JSON.stringify({ zen: "Keep it logically awesome." })
        const pong = yield* postGitHub(port, "ping", ping, { "x-hub-signature-256": sign("s3cret", ping) })
        expect(pong).toStrictEqual({ status: 202, body: { runs: [] } })

        const delivered = yield* postGitHub(port, "issue_comment", issueComment, {
          "x-hub-signature-256": sign("s3cret", issueComment),
        })
        expect(delivered.status).toBe(202)
        const [run] = yield* runsOf(routine.id)
        expect(delivered.body).toStrictEqual({ runs: [{ runId: run!.id, threadId: run!.threadId, status: "started" }] })
        const [prompt] = yield* userTexts(run!.threadId, 1)
        expect(prompt).toContain('"text": "Please look"')
      }),
    ),
  )
})
