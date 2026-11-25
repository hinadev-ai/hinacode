import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll } from "@effect/vitest"
import { NodeServices } from "@effect/platform-node"
import { Effect, Layer, Stream } from "effect"
import { SqlClient } from "effect/sql"
import type { AgentEvent } from "../../../shared/agent.ts"
import type { PushEvent } from "../../../shared/contract.ts"
import { ClaudeProvider } from "../../agents/claude/index.ts"
import { CodexProvider } from "../../agents/codex/index.ts"
import { MagpieProvider } from "../../agents/magpie/index.ts"
import { MuseProvider } from "../../agents/muse/index.ts"
import { OpencodeProvider } from "../../agents/opencode/index.ts"
import { PiProvider } from "../../agents/pi/index.ts"
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
import * as Settings from "../Settings.ts"
import * as Terminals from "../Terminals.ts"
import * as ThreadNaming from "../ThreadNaming.ts"
import * as Threads from "../Threads.ts"
import * as Worktrees from "../Worktrees.ts"
import * as Conversations from "./Conversations.ts"
import { layer as routinesLayer } from "./Routines.ts"

export const provider = (id: AgentProvider["id"]): AgentProvider => ({
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

export const unusedPort = Effect.promise(async () => {
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

export const repo = mkdtempSync(join(tmpdir(), "kk-routines-repo-"))
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

export interface Harness {
  readonly pushes: Array<PushEvent>
  readonly jobs: Map<string, Job>
}

export const makeLayer = (
  { pushes, jobs }: Harness,
  port: number,
  claude: AgentProvider,
  linear?: Layer.Layer<Linear.Linear>,
) => {
  const dataDir = mkdtempSync(join(tmpdir(), "kk-routines-"))
  writeFileSync(join(dataDir, "settings.json"), JSON.stringify({ routines: { bindHost: "127.0.0.1", port } }))
  const secrets = Secrets.layer.pipe(Layer.provide(Secrets.noKeyring))
  const domain = Layer.mergeAll(
    Threads.layer.pipe(
      Layer.provideMerge(Scratch.layer(mkdtempSync(join(tmpdir(), "kk-routines-scratch-")))),
      Layer.provideMerge(secrets),
      Layer.provide(Terminals.layer),
      Layer.provideMerge(Worktrees.layer),
      Layer.provideMerge(Projects.layer),
      Layer.provideMerge(AgentAccounts.layer),
      Layer.provideMerge(Settings.layer(dataDir)),
    ),
    Messages.layer,
    Attachments.layer(join(dataDir, "attachments")),
    linear ?? Linear.layer.pipe(Layer.provide(secrets)),
    credentialsLayer,
    Conversations.layer,
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
    Layer.provideMerge(
      Layer.mergeAll(
        Git.layer,
        GitHub.layer,
        Layer.succeed(ClaudeProvider, claude),
        Layer.succeed(CodexProvider, provider("codex")),
        Layer.succeed(MuseProvider, provider("muse")),
        Layer.succeed(OpencodeProvider, provider("opencode")),
        Layer.succeed(MagpieProvider, provider("magpie")),
        Layer.succeed(PiProvider, provider("pi")),
      ).pipe(
        Layer.provideMerge(Layer.succeed(Events, { publish: (event) => Effect.sync(() => void pushes.push(event)) })),
      ),
    ),
    Layer.provideMerge(Db.layer(":memory:")),
    Layer.provide(NodeServices.layer),
  )
}

export const seedProject = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const now = new Date(0).toISOString()
  const projectId = crypto.randomUUID()
  yield* sql`INSERT INTO project ${sql.insert({ id: projectId, name: "demo", rootPath: repo, createdAt: now, updatedAt: now })}`
  yield* McpCredentials.use((credentials) => credentials.listening("http://127.0.0.1:1/mcp"))
  return projectId
})

export const withApp = <A, E, R>(
  test: (context: { readonly projectId: string; readonly port: number } & Harness) => Effect.Effect<A, E, R>,
  claude: AgentProvider = provider("claude"),
  linear?: Layer.Layer<Linear.Linear>,
) =>
  Effect.gen(function* () {
    const port = yield* unusedPort
    const harness: Harness = { pushes: [], jobs: new Map() }
    yield* Effect.gen(function* () {
      const projectId = yield* seedProject
      return yield* test({ projectId, port, ...harness })
    }).pipe(Effect.provide(makeLayer(harness, port, claude, linear)))
  })

export const settled = (threadId: string | null) =>
  Threads.Threads.use((threads) => threads.get(threadId ?? "")).pipe(
    Effect.repeat({ until: (thread) => thread.status === "idle" }),
  )

export const finished = (threadId: string | null) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count FROM message WHERE thread_id = ${threadId ?? ""} AND role = 'assistant'
    `.pipe(Effect.repeat({ until: ([row]) => (row?.count ?? 0) > 0 }))
    return yield* settled(threadId)
  })

export const userTexts = (threadId: string | null, count: number) =>
  AgentRunner.AgentRunner.use((runner) => runner.transcript(threadId ?? "")).pipe(
    Effect.map(({ messages }) =>
      messages
        .filter((message) => message.role === "user")
        .map((message) => message.parts.map((part) => (part.type === "text" ? part.text : "")).join("")),
    ),
    Effect.repeat({ until: (texts) => texts.length >= count }),
  )
