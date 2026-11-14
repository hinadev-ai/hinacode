import { execFileSync } from "node:child_process"
import { createHmac } from "node:crypto"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "@effect/vitest"
import { NodeServices } from "@effect/platform-node"
import { Cron, Effect, Layer, Stream } from "effect"
import { SqlClient } from "effect/sql"
import type { AgentEvent } from "../../../shared/agent.ts"
import type { PushEvent } from "../../../shared/contract.ts"
import { ClaudeProvider } from "../../agents/claude/index.ts"
import { CodexProvider } from "../../agents/codex/index.ts"
import { MagpieProvider } from "../../agents/magpie/index.ts"
import { MuseProvider } from "../../agents/muse/index.ts"
import { OpencodeProvider } from "../../agents/opencode/index.ts"
import type { AgentProvider } from "../../agents/provider.ts"
import * as Db from "../../db/client.ts"
import { McpCredentials, layer as credentialsLayer } from "../../mcp/credentials.ts"
import * as AgentAccounts from "../AgentAccounts.ts"
import * as AgentRunner from "../AgentRunner.ts"
import * as Attachments from "../Attachments.ts"
import { Events } from "../Events.ts"
import * as Git from "../Git.ts"
import * as GitHub from "../GitHub.ts"
import * as Linear from "../Linear.ts"
import * as Messages from "../Messages.ts"
import * as Projects from "../Projects.ts"
import * as PullRequests from "../PullRequests.ts"
import { type Job, Scheduler } from "../Scheduler.ts"
import * as SourceControl from "../SourceControl.ts"
import * as Scratch from "../Scratch.ts"
import * as Secrets from "../Secrets.ts"
import * as ClientSettings from "../ClientSettings.ts"
import * as Settings from "../Settings.ts"
import * as Terminals from "../Terminals.ts"
import * as ThreadNaming from "../ThreadNaming.ts"
import * as Threads from "../Threads.ts"
import * as Worktrees from "../Worktrees.ts"
import { MAX_ROUTINES, Routines, layer as routinesLayer, WEBHOOK_SECRET } from "./Routines.ts"

const provider = (id: AgentProvider["id"]): AgentProvider => ({
  id,
  listModels: Effect.succeed([]),
  account: () => Effect.succeed({ type: "signedOut" }),
  planLimits: () => Effect.succeed(null),
  usage: () => Effect.succeed(null),
  listCommands: () => Effect.succeed([]),
  runTurn: () => Stream.fromIterable<AgentEvent>([{ type: "turn_completed" }]),
  steer: () => Effect.succeed(true),
  interrupt: () => Effect.void,
  respondApproval: () => Effect.succeed(false),
  respondQuestion: () => Effect.void,
  setAccessMode: () => Effect.void,
})

const unusedPort = Effect.promise(async () => {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address()
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  if (address === null || typeof address === "string") throw new Error("Expected a TCP server address")
  return address.port
})

const repo = mkdtempSync(join(tmpdir(), "kk-routines-repo-"))
execFileSync("git", ["init", "-q", "-b", "main", repo])
execFileSync("git", [
  "-C",
  repo,
  "-c",
  "user.name=t",
  "-c",
  "user.email=t@t",
  "-c",
  "commit.gpgsign=false",
  "commit",
  "-q",
  "--allow-empty",
  "-m",
  "init",
])
afterAll(() => rmSync(repo, { recursive: true, force: true }))

interface Harness {
  readonly pushes: Array<PushEvent>
  readonly jobs: Map<string, Job>
}

const makeLayer = ({ pushes, jobs }: Harness, port: number) => {
  const dataDir = mkdtempSync(join(tmpdir(), "kk-routines-"))
  writeFileSync(join(dataDir, "settings.json"), JSON.stringify({ routines: { bindHost: "127.0.0.1", port } }))
  const secrets = Secrets.layer.pipe(Layer.provide(Secrets.noKeyring))
  const domain = Layer.mergeAll(
    Threads.layer.pipe(
      Layer.provideMerge(Scratch.layer(mkdtempSync(join(tmpdir(), "kk-routines-scratch-")))),
      Layer.provide(Terminals.layer),
      Layer.provideMerge(Worktrees.layer),
      Layer.provideMerge(Projects.layer),
      Layer.provideMerge(AgentAccounts.layer),
      Layer.provideMerge(Settings.layer(dataDir)),
      Layer.provideMerge(ClientSettings.layer(dataDir)),
    ),
    Messages.layer,
    Attachments.layer(join(dataDir, "attachments")),
    secrets,
    Linear.layer.pipe(Layer.provide(secrets)),
    credentialsLayer,
  )
  const agents = AgentRunner.layer.pipe(
    Layer.provideMerge(ThreadNaming.layer.pipe(Layer.provide(domain))),
    Layer.provideMerge(PullRequests.layer.pipe(Layer.provide(domain))),
    Layer.provideMerge(domain),
  )
  const scheduler = Layer.succeed(Scheduler, {
    put: (job) => Effect.sync(() => void jobs.set(job.id, job)),
    remove: (id) => Effect.sync(() => void jobs.delete(id)),
  })
  return routinesLayer.pipe(
    Layer.provideMerge(agents),
    Layer.provide(scheduler),
    Layer.provideMerge(SourceControl.layer),
    Layer.provide(
      Layer.mergeAll(
        Git.layer,
        GitHub.layer,
        Layer.succeed(ClaudeProvider, provider("claude")),
        Layer.succeed(CodexProvider, provider("codex")),
        Layer.succeed(MuseProvider, provider("muse")),
        Layer.succeed(OpencodeProvider, provider("opencode")),
        Layer.succeed(MagpieProvider, provider("magpie")),
      ).pipe(
        Layer.provideMerge(Layer.succeed(Events, { publish: (event) => Effect.sync(() => void pushes.push(event)) })),
      ),
    ),
    Layer.provideMerge(Db.layer(":memory:")),
    Layer.provide(NodeServices.layer),
  )
}

const withApp = <A, E, R>(
  test: (context: { readonly projectId: string; readonly port: number } & Harness) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const port = yield* unusedPort
    const harness: Harness = { pushes: [], jobs: new Map() }
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const now = new Date(0).toISOString()
      const projectId = crypto.randomUUID()
      yield* sql`INSERT INTO project ${sql.insert({ id: projectId, name: "demo", rootPath: repo, createdAt: now, updatedAt: now })}`
      yield* McpCredentials.use((credentials) => credentials.listening("http://127.0.0.1:1/mcp"))
      return yield* test({ projectId, port, ...harness })
    }).pipe(Effect.provide(makeLayer(harness, port)))
  })

const hourly = { cron: "0 * * * *", timezone: "UTC" }

const createRoutine = (
  projectId: string,
  overrides: { enabled?: boolean; schedule?: typeof hourly | null; workspace?: "local" | "worktree" } = {},
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

const settled = (threadId: string | null) =>
  Threads.Threads.use((threads) => threads.get(threadId ?? "")).pipe(
    Effect.repeat({ until: (thread) => thread.status === "idle" }),
  )

const finished = (threadId: string | null) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count FROM message WHERE thread_id = ${threadId ?? ""} AND role = 'assistant'
    `.pipe(Effect.repeat({ until: ([row]) => (row?.count ?? 0) > 0 }))
    return yield* settled(threadId)
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

  it.effect("rejects an empty name, model or prompt and an unknown project", () =>
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

const post = (port: number, id: string, init: { body?: string; headers?: Record<string, string> } = {}) =>
  Effect.tryPromise(() =>
    fetch(`http://127.0.0.1:${port}/hooks/routines/${id}`, { method: "POST", ...init }).then(async (response) => ({
      status: response.status,
      body: (await response.json()) as Record<string, unknown>,
    })),
  ).pipe(Effect.retry({ times: 100 }))

const sign = (secret: string, body: string) => `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`

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
})
