import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Deferred, Effect, Layer, ManagedRuntime, type Scope, Stream } from "effect"
import { afterAll, beforeAll, expect, test, vi } from "vitest"
import { type AgentEvent, unlistedModel } from "../shared/agent.ts"
import type { RpcEnvelope } from "../shared/contract.ts"
import { ClaudeProvider } from "../main/agents/claude/index.ts"
import { CodexProvider } from "../main/agents/codex/index.ts"
import { MuseProvider } from "../main/agents/muse/index.ts"
import type { AgentProvider } from "../main/agents/provider.ts"
import * as CliSocket from "../main/remote/cliSocket.ts"
import { cliSocketPath } from "../main/remote/cliSocketPath.ts"
import { dispatch } from "../main/rpc.ts"
import { makeEventsLayer } from "../main/services/Events.ts"
import { makeTestAppLayer } from "../main/testing.ts"
import { type Client, connect } from "./client.ts"
import { loadInbox } from "./commands/inbox.ts"
import { type RunOptions, runThread } from "./commands/run.ts"
import { EXIT } from "./exit.ts"

vi.mock("electron", () => ({
  Notification: EventTarget,
  app: { getPath: () => "", focus: () => {} },
  ipcMain: { handle: () => {} },
  BrowserWindow: { getAllWindows: () => [], fromWebContents: () => null },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  shell: { showItemInFolder: () => undefined },
  safeStorage: { isEncryptionAvailable: () => false },
}))

const ASKING_PROMPT = "reset the database"

const finishingTurn: ReadonlyArray<AgentEvent> = [
  { type: "text_delta", text: "Running the tests." },
  { type: "tool_call_started", callId: "c1", name: "Bash", input: { command: "pnpm test" } },
  { type: "tool_call_finished", callId: "c1", output: "ok", isError: false },
  { type: "file_changed", path: "src/a.ts" },
  { type: "turn_completed" },
]

const answered = new Map<string, Deferred.Deferred<void>>()

const scripted = (id: AgentProvider["id"]): AgentProvider => ({
  id,
  listModels: Effect.succeed([unlistedModel(`${id}-model`, id)]),
  account: () => Effect.succeed({ type: "signedOut" }),
  planLimits: () => Effect.succeed(null),
  usage: () => Effect.succeed(null),
  listCommands: () => Effect.succeed([]),
  runTurn: (input) => {
    if (!input.prompt.includes(ASKING_PROMPT)) return Stream.fromIterable(finishingTurn)
    const requestId = `approval-${input.threadId}`
    const reply = Deferred.makeUnsafe<void>()
    answered.set(requestId, reply)
    const requested: AgentEvent = {
      type: "approval_requested",
      request: {
        id: requestId,
        threadId: input.threadId,
        provider: id,
        kind: "command",
        title: "Bash",
        detail: "",
        input: { command: "pnpm db:reset" },
      },
    }
    const resolved: AgentEvent = { type: "approval_resolved", requestId }
    return Stream.make(requested).pipe(
      Stream.concat(Stream.fromEffect(Effect.as(Deferred.await(reply), resolved))),
      Stream.concat(Stream.fromIterable(finishingTurn)),
    )
  },
  steer: () => Effect.void,
  interrupt: () => Effect.void,
  respondApproval: (requestId) =>
    Effect.as(Deferred.succeed(answered.get(requestId) ?? Deferred.makeUnsafe<void>(), undefined), true),
  respondQuestion: () => Effect.void,
  setAccessMode: () => Effect.void,
})

const providers = Layer.mergeAll(
  Layer.succeed(ClaudeProvider, scripted("claude")),
  Layer.succeed(CodexProvider, scripted("codex")),
  Layer.succeed(MuseProvider, scripted("muse")),
)

const makeApp = (dataDir: string) => {
  const events = makeEventsLayer(() => {})
  return ManagedRuntime.make(
    CliSocket.layer(dataDir).pipe(
      Layer.provideMerge(makeTestAppLayer(join(dataDir, "hinacode.sqlite"), { providers, events })),
      Layer.provide(events),
    ),
  )
}

const result = <A>(envelope: RpcEnvelope<A>): A => {
  if ("error" in envelope) throw new Error(`${envelope.error.tag}: ${envelope.error.message}`)
  return envelope.result
}

let dir = ""
let repo = ""
let app: ReturnType<typeof makeApp>

const withCli = <A, E>(use: (client: Client) => Effect.Effect<A, E, Scope.Scope>) =>
  Effect.runPromise(Effect.scoped(Effect.flatMap(connect(cliSocketPath(join(dir, "app"))), use)))

const options = (prompt: string, wait: boolean): RunOptions => ({
  prompt,
  cwd: repo,
  project: undefined,
  machine: undefined,
  provider: undefined,
  model: undefined,
  effort: undefined,
  accessMode: undefined,
  workspace: undefined,
  from: undefined,
  attach: [],
  wait,
})

const run = (prompt: string, wait: boolean) => withCli((client) => runThread(client, options(prompt, wait)))

const statusOf = async (threadId: string) =>
  (await withCli((client) => client.call("threads.list", undefined))).find((thread) => thread.id === threadId)?.status

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "kk-cli-run-test-"))
  repo = join(dir, "repo")
  execFileSync("git", ["init", "-q", "-b", "main", repo])
  execFileSync("git", [
    "-C",
    repo,
    "-c",
    "user.email=t@t",
    "-c",
    "user.name=t",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "i",
  ])
  mkdirSync(join(dir, "app"), { mode: 0o700 })
  app = makeApp(join(dir, "app"))
  result(
    await app.runPromise(
      dispatch({ method: "projects.create", payload: { name: "web", rootPath: repo, setupScript: null } }, null),
    ),
  )
}, 60_000)

afterAll(async () => {
  await app.dispose()
  rmSync(dir, { recursive: true, force: true })
})

test("run prints the new thread's id and returns once the prompt is sent", async () => {
  const { value, code } = await run("make the tests pass", false)
  expect(code).toBe(EXIT.done)
  const { threadId } = value as { threadId: string }
  expect(value).toStrictEqual({ threadId, title: expect.any(String), projectId: expect.any(String) })

  const transcript = await withCli((client) => client.call("threads.transcript", { threadId }))
  expect(transcript.messages[0]?.parts).toStrictEqual([{ type: "text", text: "make the tests pass" }])
  expect(await statusOf(threadId)).not.toBe("draft")
})

test("run --wait ends with the done outcome", async () => {
  const { value, code } = await run("make the tests pass", true)
  expect(code).toBe(EXIT.done)
  expect(value).toMatchObject({ outcome: "done", title: expect.any(String) })
})

test("run --wait exits 2 on an approval, the inbox lists it, and answering it lets the turn finish", async () => {
  const { value, code } = await run(ASKING_PROMPT, true)
  expect(code).toBe(EXIT.needsHuman)
  const { threadId } = value as { threadId: string }
  expect(value).toStrictEqual({ threadId, title: expect.any(String), outcome: "needsHuman" })

  const inbox = await vi.waitFor(async () => {
    const loaded = await withCli(loadInbox)
    expect(loaded.asks).toHaveLength(1)
    return loaded
  })
  const [ask] = inbox.asks
  expect(ask).toMatchObject({ kind: "approval", threadId, request: { input: { command: "pnpm db:reset" } } })

  await withCli((client) => client.call("approvals.respond", { requestId: `approval-${threadId}`, decision: "allow" }))
  await vi.waitFor(async () => expect(await statusOf(threadId)).toBe("idle"))
  expect((await withCli(loadInbox)).asks).toStrictEqual([])
})
