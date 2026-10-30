import { execFileSync } from "node:child_process"
import { EventEmitter } from "node:events"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { type AddressInfo, createConnection, createServer } from "node:net"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { afterAll, afterEach, beforeAll, describe, expect, test } from "@effect/vitest"
import { vi } from "vitest"
import { type Duration, Effect, Layer, ManagedRuntime, Queue, Stream } from "effect"
import { WebSocket } from "ws"
import { TestClock } from "effect/testing"
import type { AccountHome, AgentEvent, ApprovalDecision, Subagent, ThreadUsage } from "../shared/agent.ts"
import { unlistedModel } from "../shared/agent.ts"
import { EVENT_CHANNEL, RPC_CHANNEL } from "../shared/channels.ts"
import type { PushEvent, RpcEnvelope, RpcMethod, RpcRequestEncoded, RpcResponseEncoded } from "../shared/contract.ts"
import { clientProof, newNonce, serverProof } from "../shared/proof.ts"
import { type ClientFrame, remoteWebSocketUrl, type ServerFrame } from "../shared/remote.ts"
import { defaultSettings, type Message, type Project, type Thread, type Worktree } from "../shared/domain.ts"
import type { PlanLimits } from "../shared/limits.ts"
import { ClaudeProvider } from "./agents/claude/index.ts"
import { CodexProvider } from "./agents/codex/index.ts"
import { MuseProvider } from "./agents/muse/index.ts"
import { AgentError, type AgentProvider, type Wake } from "./agents/provider.ts"
import { registerIpc } from "./ipc.ts"
import { makeTestAppLayer } from "./testing.ts"
import { Events } from "./services/Events.ts"
import * as Messages from "./services/Messages.ts"
import * as RemoteAccess from "./remote/access.ts"
import { MAX_CALL_KEYS } from "./remote/server.ts"
import { unusedLoopbackPort } from "./remote/testing.ts"
import * as PullRequests from "./services/PullRequests.ts"
import * as Settings from "./services/Settings.ts"
import * as Threads from "./services/Threads.ts"
import * as Worktrees from "./services/Worktrees.ts"

type IpcHandler = (event: { sender: object; senderFrame: Frame }, raw: unknown) => Promise<unknown>
interface Frame {
  readonly url: string
  readonly parent: Frame | null
}

const electron = vi.hoisted(() => ({
  handlers: new Map<string, IpcHandler>(),
  pushes: [] as Array<{ channel: string; payload: unknown }>,
  watchers: new Set<() => void>(),
  shown: [] as Array<object>,
  restored: [] as Array<object>,
  focused: [] as Array<object>,
  notifications: [] as Array<{ title: string; body: string; silent: boolean }>,
  notificationOutcome: "show" as "show" | "failed",
  userData: "",
}))

vi.mock("electron", () => ({
  Notification: class extends EventEmitter {
    constructor(options: { title: string; body: string; silent: boolean }) {
      super()
      electron.notifications.push(options)
    }
    show() {
      this.emit(electron.notificationOutcome)
    }
  },
  app: { getPath: () => electron.userData, focus: () => {} },
  ipcMain: { handle: (channel: string, handler: IpcHandler) => electron.handlers.set(channel, handler) },
  BrowserWindow: {
    getAllWindows: () => [
      {
        webContents: {
          send: (channel: string, payload: unknown) => {
            electron.pushes.push({ channel, payload })
            for (const notify of electron.watchers) notify()
          },
        },
      },
    ],
    fromWebContents: (sender: object) => ({
      isMinimized: () => true,
      restore: () => {
        electron.restored.push(sender)
      },
      focus: () => {
        electron.focused.push(sender)
      },
      show: () => {
        electron.shown.push(sender)
      },
    }),
  },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  shell: { showItemInFolder: () => undefined },
  safeStorage: { isEncryptionAvailable: () => false },
}))

const appUrl = "file:///opt/hinacode/out/renderer/index.html"
const mainFrame: Frame = { url: appUrl, parent: null }

const subagent: Subagent = {
  id: "task-1",
  label: "Count repo files",
  callId: "toolu_01DoGmNCXkV2M8SMNaE7E3XJ",
  status: "running",
  summary: null,
  lastTool: null,
  toolUses: 0,
  tokens: 0,
  startedAt: "2026-10-12T10:00:00.000Z",
  endedAt: null,
}

const scriptedTurn: ReadonlyArray<AgentEvent> = [
  { type: "subagent_updated", subagent },
  { type: "text_delta", text: "Spawned one sub-agent." },
  {
    type: "subagent_updated",
    subagent: { ...subagent, status: "completed", summary: "218 files", lastTool: "Bash", toolUses: 1, tokens: 14310 },
  },
  { type: "turn_completed" },
]

const boundSession = "31ee17f8-6200-4a50-80ff-96241b83319e"
const sessionUsage: ThreadUsage = {
  models: [{ model: "claude-model", inputTokens: 6, cacheWriteTokens: 1050, cacheReadTokens: 3000, outputTokens: 220 }],
  transcripts: 3,
}

const claudeLimits: PlanLimits = {
  windows: [{ window: { kind: "session" }, usedPercent: 79, resetsAt: "2026-10-12T15:00:00.000Z" }],
  readAt: "2026-10-12T10:00:00.000Z",
}

let heldTurn = Promise.withResolvers<void>()
const approvalAnswers: Array<{ requestId: string; decision: ApprovalDecision; note?: string }> = []

const stoppedSubagents: Array<{ readonly threadId: string; readonly subagentId: string }> = []

const claudeWakes = Effect.runSync(Queue.unbounded<Wake>())

const turnHomes: Array<AccountHome | null> = []
const turnResumes: Array<{ readonly resumeSessionId: string | null; readonly forkAt: string | null }> = []
const turnPrompts: Array<string> = []

const copiedSessions: Array<{
  readonly sessionId: string
  readonly from: AccountHome | null
  readonly to: AccountHome | null
}> = []

const scriptedProvider = (id: AgentProvider["id"]): AgentProvider => ({
  id,
  listModels: Effect.succeed([unlistedModel(`${id}-model`, id)]),
  account: (home) =>
    Effect.succeed(
      home === null
        ? { type: "signedOut" }
        : { type: "subscription", email: `${basename(home.dir)}@example.com`, plan: null, organization: null },
    ),
  planLimits: (home) =>
    id === "claude"
      ? Effect.succeed(home === null ? claudeLimits : null)
      : Effect.fail(new AgentError({ provider: id, message: "app-server is not installed" })),
  usage: (sessionId) => Effect.succeed(sessionId === boundSession ? sessionUsage : null),
  copySession: (sessionId, from, to) => Effect.sync(() => void copiedSessions.push({ sessionId, from, to })),
  listCommands: () => Effect.succeed([]),
  runTurn: (input) =>
    Stream.suspend(() => {
      turnHomes.push(input.home)
      turnResumes.push({ resumeSessionId: input.resumeSessionId, forkAt: input.forkAt })
      turnPrompts.push(input.prompt)
      if (input.prompt === "simulate a held sub-agent") {
        return Stream.make<Array<AgentEvent>>({ type: "subagent_updated", subagent }).pipe(
          Stream.concat(Stream.fromEffect(Effect.promise(() => heldTurn.promise)).pipe(Stream.drain)),
          Stream.concat(Stream.make<Array<AgentEvent>>({ type: "turn_completed" })),
        )
      }
      if (input.prompt === "simulate a held approval") {
        const requested: AgentEvent = {
          type: "approval_requested",
          request: {
            id: `approval-${input.threadId}`,
            threadId: input.threadId,
            provider: id,
            kind: "command",
            title: "Run command",
            detail: "npm test",
          },
        }
        return Stream.make<Array<AgentEvent>>(requested).pipe(
          Stream.concat(Stream.fromEffect(Effect.promise(() => heldTurn.promise)).pipe(Stream.drain)),
          Stream.concat(Stream.make<Array<AgentEvent>>({ type: "turn_completed" })),
        )
      }
      if (input.prompt === "simulate a held turn") {
        return Stream.fromEffect(Effect.promise(() => heldTurn.promise)).pipe(
          Stream.flatMap(() => Stream.fromIterable(scriptedTurn)),
        )
      }
      return Stream.fromIterable(
        input.prompt === "simulate a session"
          ? [{ type: "session_bound", providerSessionId: boundSession }, { type: "turn_completed" }]
          : input.prompt === "simulate a forkable turn"
            ? [
                { type: "session_bound", providerSessionId: "source-session" },
                { type: "text_delta", text: "Here is a plan." },
                { type: "turn_completed", forkPoint: { sessionId: "source-session", checkpoint: "turn-1" } },
              ]
            : input.prompt === "simulate unanswered question"
              ? [
                  {
                    type: "question_requested",
                    request: {
                      id: `question-${input.threadId}`,
                      threadId: input.threadId,
                      provider: id,
                      questions: [],
                    },
                  },
                  { type: "turn_failed", message: "Provider disconnected before the answer" },
                ]
              : input.prompt === "simulate a tool call"
                ? [
                    { type: "tool_call_started", callId: "call-1", name: "Bash", input: { command: "ls" } },
                    { type: "tool_call_finished", callId: "call-1", output: "a.txt\nb.txt", isError: false },
                    { type: "file_changed", path: "a.txt", diff: "@@ -0,0 +1 @@\n+a" },
                    { type: "text_delta", text: "Listed and edited." },
                    { type: "turn_completed" },
                  ]
                : input.prompt === "simulate a crash mid sub-agent"
                  ? [
                      { type: "subagent_updated", subagent },
                      { type: "turn_failed", message: "Claude Code session ended unexpectedly" },
                    ]
                  : input.prompt === "simulate usage limit" && input.home === null
                    ? [
                        {
                          type: "turn_limited",
                          limit: {
                            kind: "usage",
                            message: "Usage limit reached",
                            reset: { at: "2099-01-01T00:00:00.000Z", autoResume: false },
                          },
                        },
                      ]
                    : input.prompt === "simulate a passed usage limit"
                      ? [
                          {
                            type: "turn_limited",
                            limit: {
                              kind: "usage",
                              message: "Usage limit reached",
                              reset: { at: "2000-01-01T00:00:00.000Z", autoResume: false },
                            },
                          },
                        ]
                      : scriptedTurn,
      )
    }),
  ...(id === "claude" ? { wakes: Stream.fromQueue(claudeWakes) } : {}),
  steer: () => Effect.void,
  interrupt: () => Effect.void,
  stopSubagent: (threadId, subagentId) => Effect.sync(() => void stoppedSubagents.push({ threadId, subagentId })),
  respondApproval: (requestId, decision, note) =>
    Effect.sync(() => approvalAnswers.push({ requestId, decision, ...(note !== undefined && { note }) })).pipe(
      Effect.as(true),
    ),
  respondQuestion: () => Effect.void,
  setAccessMode: () => Effect.void,
})

const providers = Layer.mergeAll(
  Layer.succeed(ClaudeProvider, scriptedProvider("claude")),
  Layer.succeed(CodexProvider, scriptedProvider("codex")),
  Layer.succeed(MuseProvider, scriptedProvider("muse")),
)

const makeLayer = (dbPath: string) => makeTestAppLayer(dbPath, { providers })

let dir = ""
let repo = ""
let runtime: ManagedRuntime.ManagedRuntime<Layer.Success<ReturnType<typeof makeLayer>>, unknown>

const invoke = <M extends RpcMethod>(method: M, payload: RpcRequestEncoded<M>, senderFrame: Frame = mainFrame) =>
  electron.handlers.get(RPC_CHANNEL)!({ sender: {}, senderFrame }, { method, payload }) as Promise<
    RpcEnvelope<RpcResponseEncoded<M>>
  >

const result = <A>(envelope: RpcEnvelope<A>): A => {
  if ("error" in envelope) throw new Error(`${envelope.error.tag}: ${envelope.error.message}`)
  return envelope.result
}

const failure = (envelope: RpcEnvelope<unknown>) => {
  if ("result" in envelope) throw new Error(`expected an error, got ${JSON.stringify(envelope.result)}`)
  return envelope.error
}

const pushed = () =>
  electron.pushes.filter((push) => push.channel === EVENT_CHANNEL).map((push) => push.payload as PushEvent)

const pushedEventually = (predicate: (event: PushEvent) => boolean) =>
  new Promise<void>((resolve) => {
    const check = () => {
      if (!pushed().some(predicate)) return
      electron.watchers.delete(check)
      resolve()
    }
    electron.watchers.add(check)
    check()
  })

const createProject = async (name: string) =>
  result(await invoke("projects.create", { name, rootPath: repo, setupScript: null }))

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "kk-ipc-test-"))
  electron.userData = dir
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
    "init",
  ])
  runtime = ManagedRuntime.make(makeLayer(join(dir, "hinacode.sqlite")))
  registerIpc(runtime, appUrl)
})

afterAll(async () => {
  await runtime.dispose()
  rmSync(dir, { recursive: true, force: true })
})

describe("rpc trust boundary", () => {
  test("only a trusted, valid app.ready call shows its sender's window", async () => {
    const handler = electron.handlers.get(RPC_CHANNEL)
    if (!handler) throw new Error("RPC handler is missing")
    const sender = {}
    const request = { method: "app.ready", payload: undefined }
    electron.shown.length = 0
    expect(
      await handler({ sender, senderFrame: { url: "file:///tmp/probe.html", parent: null } }, request),
    ).toMatchObject({ error: { tag: "UntrustedSender" } })
    expect(await handler({ sender, senderFrame: { url: appUrl, parent: mainFrame } }, request)).toMatchObject({
      error: { tag: "UntrustedSender" },
    })
    expect(await handler({ sender, senderFrame: mainFrame }, { method: 4, payload: undefined })).toMatchObject({
      error: { tag: "SchemaError" },
    })
    expect(electron.shown).toStrictEqual([])
    expect(await handler({ sender, senderFrame: mainFrame }, request)).toStrictEqual({ result: undefined })
    expect(electron.shown).toStrictEqual([sender])
  })

  test("only a valid app.focus call from the app frame restores and focuses its own window", async () => {
    const handler = electron.handlers.get(RPC_CHANNEL)
    if (!handler) throw new Error("RPC handler is missing")
    const sender = {}
    const request = { method: "app.focus", payload: undefined }
    electron.shown.length = 0
    electron.restored.length = 0
    electron.focused.length = 0
    expect(
      await handler({ sender, senderFrame: { url: "file:///tmp/probe.html", parent: null } }, request),
    ).toMatchObject({ error: { tag: "UntrustedSender" } })
    expect(await handler({ sender, senderFrame: { url: appUrl, parent: mainFrame } }, request)).toMatchObject({
      error: { tag: "UntrustedSender" },
    })
    expect(await handler({ sender, senderFrame: mainFrame }, { method: 4, payload: undefined })).toMatchObject({
      error: { tag: "SchemaError" },
    })
    expect(electron.shown).toStrictEqual([])
    expect(electron.restored).toStrictEqual([])
    expect(electron.focused).toStrictEqual([])
    expect(await handler({ sender, senderFrame: mainFrame }, request)).toStrictEqual({ result: undefined })
    expect(electron.shown).toStrictEqual([sender])
    expect(electron.restored).toStrictEqual([sender])
    expect(electron.focused).toStrictEqual([sender])
  })

  test("refuses calls from documents that are not the app and from subframes", async () => {
    const foreign = await invoke("settings.get", undefined, { url: "file:///tmp/probe.html", parent: null })
    expect(failure(foreign).tag).toBe("UntrustedSender")
    const subframe = await invoke("settings.get", undefined, { url: appUrl, parent: mainFrame })
    expect(failure(subframe).tag).toBe("UntrustedSender")
    expect("result" in (await invoke("settings.get", undefined))).toBe(true)
  })
})

describe("rpc contract", () => {
  test("notification permission requests validate payloads and reject foreign frames before showing anything", async () => {
    electron.notifications.length = 0
    const payload = { title: "hinacode", body: "Permission check" }
    expect(
      failure(await invoke("notifications.askPermission", payload, { url: "file:///tmp/probe.html", parent: null }))
        .tag,
    ).toBe("UntrustedSender")
    expect(failure(await invoke("notifications.askPermission", payload, { url: appUrl, parent: mainFrame })).tag).toBe(
      "UntrustedSender",
    )
    expect(
      failure(await invoke("notifications.askPermission", { title: 4 as unknown as string, body: "invalid" })).tag,
    ).toBe("SchemaError")
    expect(electron.notifications).toStrictEqual([])
  })

  test("notification permission requests report the native result and always remain silent", async () => {
    electron.notifications.length = 0
    const payload = { title: "hinacode", body: "Permission check" }
    electron.notificationOutcome = "show"
    expect(result(await invoke("notifications.askPermission", payload))).toBe("shown")
    electron.notificationOutcome = "failed"
    expect(result(await invoke("notifications.askPermission", payload))).toBe("refused")
    electron.notificationOutcome = "show"
    expect(electron.notifications).toStrictEqual([
      { ...payload, silent: true },
      { ...payload, silent: true },
    ])
    expect(["unknown", "granted", "denied", "notDetermined"]).toContain(
      result(await invoke("notifications.permission", undefined)),
    )
  })

  test("answers an unknown method and a payload outside the contract with a schema error", async () => {
    const unknown = await invoke("no.such.method" as RpcMethod, undefined as never)
    expect(failure(unknown).tag).toBe("SchemaError")
    const payload = await invoke("threads.update", { id: "t", provider: "gpt" as "claude" })
    expect(failure(payload).tag).toBe("SchemaError")
  })

  test("surfaces a handler's tagged error with its message", async () => {
    const file = join(dir, "notes.txt")
    writeFileSync(file, "")
    const error = failure(
      await invoke("projects.create", {
        name: "nope",
        rootPath: file,
        setupScript: null,
      }),
    )
    expect(error.tag).toBe("ProjectRootInvalidError")
    expect(error.message).toContain("is not a directory")
  })
})

describe("projects, threads and settings over rpc", () => {
  afterEach(async () => {
    const { defaultProvider, defaultModel, defaultEffort, defaultFastMode, defaultAccessMode, defaultWorkspaceMode } =
      defaultSettings
    result(
      await invoke("settings.set", {
        defaultProvider,
        defaultModel,
        defaultEffort,
        defaultFastMode,
        defaultAccessMode,
        defaultWorkspaceMode,
      }),
    )
  })

  test("a created project is listed and can be read back", async () => {
    const project = await createProject("repo")
    expect(project).toMatchObject({ name: "repo", rootPath: repo, setupScript: null } satisfies Partial<Project>)
    const listed = result(await invoke("projects.list", undefined))
    expect(listed.map((item) => item.id)).toContain(project.id)
    const duplicate = await invoke("projects.create", {
      name: "again",
      rootPath: repo,
      setupScript: null,
    })
    expect(failure(duplicate).tag).toBe("ProjectPathTakenError")
  })

  test("a thread is created idle in its project with the default agent and removed on delete", async () => {
    const project = result(await invoke("projects.list", undefined))[0]!
    const thread = result(await invoke("threads.create", { projectId: project.id }))
    expect(thread).toMatchObject({
      projectId: project.id,
      provider: "claude",
      model: "claude-model",
      status: "idle",
      worktreeId: null,
    } satisfies Partial<Thread>)
    expect(thread.title).toMatch(/^thread-/)
    expect(result(await invoke("threads.list", undefined)).map((item) => item.id)).toContain(thread.id)
    result(await invoke("threads.delete", { id: thread.id, removeWorktree: false }))
    expect(result(await invoke("threads.list", undefined)).map((item) => item.id)).not.toContain(thread.id)
  })

  test("lists every thread's linked pull requests in one call", async () => {
    const project = result(await invoke("projects.list", undefined))[0]!
    const threadOf = async () => result(await invoke("threads.create", { projectId: project.id }))
    const [first, second] = [await threadOf(), await threadOf()]
    await runtime.runPromise(
      PullRequests.PullRequests.use((pullRequests) =>
        Effect.all([
          pullRequests.link(first.id, "https://github.com/hinadev-ai/hinacode/pull/48"),
          pullRequests.link(first.id, "https://github.com/hinadev-ai/hinacode/pull/49"),
          pullRequests.link(second.id, "https://github.com/hinadev-ai/hinacode/pull/55"),
        ]),
      ),
    )
    const links = result(await invoke("pullRequests.all", undefined))
    expect(links.map((link) => [link.threadId, link.url])).toStrictEqual([
      [first.id, "https://github.com/hinadev-ai/hinacode/pull/48"],
      [first.id, "https://github.com/hinadev-ai/hinacode/pull/49"],
      [second.id, "https://github.com/hinadev-ai/hinacode/pull/55"],
    ])
  })

  test("a thread loads the user's own skills until conversation mode turns them off", async () => {
    const project = result(await invoke("projects.list", undefined))[0]!
    const thread = result(await invoke("threads.create", { projectId: project.id }))
    expect(thread.userSkills).toBe(true)
    result(await invoke("threads.update", { id: thread.id, userSkills: false }))
    const stored = result(await invoke("threads.list", undefined)).find((listed) => listed.id === thread.id)
    expect(stored?.userSkills).toBe(false)
  })

  test("a thread switches agent, back to that agent's defaults, and marks a switch after its first message", async () => {
    const project = result(await invoke("projects.list", undefined))[0]!
    const thread = result(await invoke("threads.create", { projectId: project.id }))
    result(await invoke("threads.update", { id: thread.id, effort: "max", fastMode: true }))
    const switched = result(await invoke("threads.update", { id: thread.id, provider: "codex" }))
    expect(switched).toMatchObject({
      provider: "codex",
      model: "codex-model",
      effort: null,
      fastMode: false,
    } satisfies Partial<Thread>)

    await runtime.runPromise(
      Messages.Messages.use((messages) =>
        messages.insert({
          id: "m1",
          threadId: thread.id,
          role: "user",
          parts: [{ type: "text", text: "hi" }],
          createdAt: "2026-10-12T00:00:00.000Z",
          completedAt: "2026-10-12T00:00:00.000Z",
          usage: null,
          forkPoint: null,
        }),
      ),
    )
    expect(result(await invoke("threads.update", { id: thread.id, provider: "claude" }))).toMatchObject({
      provider: "claude",
      providerSessionId: null,
    } satisfies Partial<Thread>)
    const { messages } = result(await invoke("threads.transcript", { threadId: thread.id }))
    expect(messages.at(-1)?.parts).toStrictEqual([{ type: "agent_switch", from: "codex", to: "claude" }])
  })

  test("a new thread starts in the default access mode and keeps the one it is switched to", async () => {
    const project = result(await invoke("projects.list", undefined))[0]!
    const thread = result(await invoke("threads.create", { projectId: project.id }))
    expect(thread.accessMode).toBe("full")

    result(await invoke("settings.set", { defaultAccessMode: "auto" }))
    const next = result(await invoke("threads.create", { projectId: project.id }))
    expect(next.accessMode).toBe("auto")
    result(await invoke("settings.set", { defaultAccessMode: "full" }))

    result(await invoke("threads.update", { id: thread.id, accessMode: "supervised" }))
    const listed = result(await invoke("threads.list", undefined)).find((item) => item.id === thread.id)
    expect(listed?.accessMode).toBe("supervised")
  })

  test("a new thread starts as the last new thread was set up, ignoring changes after its first message", async () => {
    const project = result(await invoke("projects.list", undefined))[0]!
    const first = result(await invoke("threads.create", { projectId: project.id }))
    result(await invoke("threads.update", { id: first.id, provider: "codex" }))
    result(await invoke("threads.update", { id: first.id, effort: "high", fastMode: true, accessMode: "auto" }))
    result(await invoke("settings.set", { defaultWorkspaceMode: "worktree" }))
    result(await invoke("threads.send", { threadId: first.id, prompt: "hi" }))

    const second = result(await invoke("threads.create", { projectId: project.id }))
    expect(second).toMatchObject({
      provider: "codex",
      model: "codex-model",
      effort: "high",
      fastMode: true,
      accessMode: "auto",
    } satisfies Partial<Thread>)
    expect(result(await invoke("settings.get", undefined)).defaultWorkspaceMode).toBe("local")

    result(await invoke("threads.update", { id: first.id, accessMode: "supervised" }))
    expect(result(await invoke("threads.create", { projectId: project.id })).accessMode).toBe("auto")
  })

  test("reordering a thread keeps its updatedAt", async () => {
    const project = result(await invoke("projects.list", undefined))[0]!
    const created = result(await invoke("threads.create", { projectId: project.id }))
    const thread = await runtime.runPromise(
      Threads.Threads.use((threads) => threads.update({ id: created.id, title: "old" })).pipe(
        Effect.provide(TestClock.layer()),
      ),
    )
    expect(thread.updatedAt).toBe("1970-01-01T00:00:00.000Z")

    const moved = result(await invoke("threads.update", { id: thread.id, sortIndex: thread.sortIndex + 10 }))
    expect(moved.updatedAt).toBe(thread.updatedAt)
    const listed = result(await invoke("threads.list", undefined)).find((item) => item.id === thread.id)
    expect(listed).toMatchObject({ sortIndex: thread.sortIndex + 10, updatedAt: thread.updatedAt })
  })

  test("pinning a thread stamps pinnedAt once and keeps its updatedAt", async () => {
    const project = result(await invoke("projects.list", undefined))[0]!
    const thread = result(await invoke("threads.create", { projectId: project.id }))
    expect(thread.pinnedAt).toBeNull()

    const pinned = result(await invoke("threads.update", { id: thread.id, pinned: true }))
    expect(pinned.pinnedAt).not.toBeNull()
    expect(pinned.updatedAt).toBe(thread.updatedAt)
    const repinned = result(await invoke("threads.update", { id: thread.id, pinned: true }))
    expect(repinned.pinnedAt).toBe(pinned.pinnedAt)

    const unpinned = result(await invoke("threads.update", { id: thread.id, pinned: false }))
    expect(unpinned.pinnedAt).toBeNull()
    const listed = result(await invoke("threads.list", undefined)).find((item) => item.id === thread.id)
    expect(listed).toMatchObject({ pinnedAt: null, updatedAt: thread.updatedAt })
  })

  test("snoozing keeps a thread's updatedAt, and activity wakes it", async () => {
    const project = result(await invoke("projects.list", undefined))[0]!
    const thread = result(await invoke("threads.create", { projectId: project.id }))
    expect(thread.snoozedUntil).toBeNull()

    const until = "2026-11-02T08:00:00.000Z"
    const snoozed = result(await invoke("threads.update", { id: thread.id, snoozedUntil: until }))
    expect(snoozed).toMatchObject({ snoozedUntil: until, updatedAt: thread.updatedAt })
    const listed = result(await invoke("threads.list", undefined)).find((item) => item.id === thread.id)
    expect(listed?.snoozedUntil).toBe(until)

    const pinned = result(await invoke("threads.update", { id: thread.id, pinned: true }))
    expect(pinned.snoozedUntil).toBe(until)

    const active = result(await invoke("threads.update", { id: thread.id, status: "idle" }))
    expect(active.snoozedUntil).toBeNull()

    result(await invoke("threads.update", { id: thread.id, snoozedUntil: until }))
    const woken = result(await invoke("threads.update", { id: thread.id, snoozedUntil: null }))
    expect(woken.snoozedUntil).toBeNull()
  })

  test("lists the files a thread can mention: tracked and untracked, but not ignored", async () => {
    const project = result(await invoke("projects.list", undefined))[0]!
    const thread = result(await invoke("threads.create", { projectId: project.id }))
    writeFileSync(join(repo, ".gitignore"), "secret.env\n")
    writeFileSync(join(repo, "secret.env"), "TOKEN=1")
    writeFileSync(join(repo, "notes.txt"), "hello")
    const files = result(await invoke("files.list", { threadId: thread.id }))
    expect(files).toContain("notes.txt")
    expect(files).toContain(".gitignore")
    expect(files).not.toContain("secret.env")
  })

  test("lists a folder only for the app frame, a known root, and a path inside it", async () => {
    const { rootPath } = result(await invoke("projects.list", undefined))[0]!
    mkdirSync(join(repo, "docs"), { recursive: true })
    const listed = result(await invoke("fs.list", { root: rootPath, path: "" }))
    expect(listed.find((entry) => entry.name === "docs")?.kind).toBe("dir")

    const subframe = await invoke("fs.list", { root: rootPath, path: "" }, { url: appUrl, parent: mainFrame })
    expect(failure(subframe).tag).toBe("UntrustedSender")
    expect(failure(await invoke("fs.list", { root: dir, path: "" })).tag).toBe("FsAccessError")
    expect(failure(await invoke("fs.list", { root: rootPath, path: ".." })).tag).toBe("FsAccessError")
    expect(failure(await invoke("fs.watch", { root: dir, paths: [""] })).tag).toBe("FsAccessError")
    expect(failure(await invoke("fs.read", { root: rootPath, path: "../hinacode.sqlite" })).tag).toBe("FsAccessError")
    const outsideWrite = await invoke("fs.write", { root: dir, path: "hinacode.sqlite", content: "", expected: null })
    expect(failure(outsideWrite).tag).toBe("FsAccessError")
  })

  test("cloning into a folder that already holds that repository adds it without cloning", async () => {
    const clone = join(dir, "myprofile")
    execFileSync("git", ["init", "-q", clone])
    execFileSync("git", ["-C", clone, "remote", "add", "origin", "git@github.com:kjj6198/myprofile.git"])
    const project = result(
      await invoke("projects.clone", {
        repository: { owner: "kjj6198", name: "myprofile" },
        rootPath: clone,
        name: "myprofile",
        setupScript: null,
      }),
    )
    expect(project).toMatchObject({ name: "myprofile", rootPath: clone } satisfies Partial<Project>)
  })

  test("refuses a clone target that is not an absolute path, and a repository that is not owner/name", async () => {
    const repository = { owner: "kjj6198", name: "myprofile" }
    const relative = await invoke("projects.clone", { repository, rootPath: "code/x", name: "x", setupScript: null })
    expect(failure(relative).tag).toBe("ProjectRootInvalidError")
    const flag = await invoke("projects.clone", {
      repository: { owner: "--upload-pack=x", name: "y" },
      rootPath: join(dir, "y"),
      name: "y",
      setupScript: null,
    })
    expect(failure(flag).tag).toBe("SchemaError")
  })

  test("settings written through rpc are what the next read returns", async () => {
    const saved = result(await invoke("settings.set", { textGenerationModel: "claude-haiku", worktreeRoot: "/tmp/wt" }))
    expect(saved).toMatchObject({ textGenerationModel: "claude-haiku", worktreeRoot: "/tmp/wt" })
    expect(result(await invoke("settings.get", undefined))).toStrictEqual(saved)

    const client = result(
      await invoke("clientSettings.set", { locale: "zh-TW", keybindings: { "sidebar.toggle": "mod+k" } }),
    )
    expect(client).toMatchObject({ locale: "zh-TW", keybindings: { "sidebar.toggle": "mod+k" } })
    expect(result(await invoke("clientSettings.get", undefined))).toStrictEqual(client)
    expect(result(await invoke("settings.get", undefined))).toStrictEqual(saved)
  })

  test("notification preferences persist through the derived client settings patch", async () => {
    const before = result(await invoke("clientSettings.get", undefined))
    const notifications = { completed: false, needsInput: true, failed: false, sound: false }
    const saved = result(await invoke("clientSettings.set", { notifications }))
    expect(saved).toStrictEqual({ ...before, notifications })
    expect(result(await invoke("clientSettings.get", undefined))).toStrictEqual(saved)

    const malformed = await invoke("clientSettings.set", { notifications: { ...notifications, sound: "yes" } } as never)
    expect(malformed).toMatchObject({ error: { tag: "SchemaError" } })
    expect(result(await invoke("clientSettings.get", undefined))).toStrictEqual(saved)
  })

  test("sidebar groups persist through the client settings patch", async () => {
    const before = result(await invoke("clientSettings.get", undefined))
    expect(before.sidebarGroups).toStrictEqual({ groups: [], groupOf: {} })
    const sidebarGroups = {
      groups: [{ id: "work", name: "Work", collapsed: true }],
      groupOf: { "acme/web": "work" },
    }
    const saved = result(await invoke("clientSettings.set", { sidebarGroups }))
    expect(saved).toStrictEqual({ ...before, sidebarGroups })
    expect(result(await invoke("clientSettings.get", undefined))).toStrictEqual(saved)
  })

  test("creating a worktree pushes its state changes to every window", async () => {
    const project = result(await invoke("projects.list", undefined))[0]!
    writeFileSync(join(repo, "README.md"), "hello")
    electron.pushes.length = 0
    const worktree = result(
      await invoke("worktrees.create", { projectId: project.id, branch: "kk/ipc", baseRef: "main" }),
    )
    expect(worktree).toMatchObject({
      branch: "kk/ipc",
      baseRef: "main",
      status: "preparing",
    } satisfies Partial<Worktree>)

    await pushedEventually(
      (event) =>
        event.type === "worktree.updated" && event.worktree.id === worktree.id && event.worktree.status === "ready",
    )
    expect(result(await invoke("worktrees.list", undefined)).find((item) => item.id === worktree.id)?.status).toBe(
      "ready",
    )
    const updates = pushed().filter((event) => event.type === "worktree.updated")
    expect(updates.map((event) => event.type === "worktree.updated" && event.worktree.status)).toStrictEqual([
      "preparing",
      "ready",
    ])
    result(await invoke("worktrees.remove", { id: worktree.id, deleteBranch: "force" }))
  })

  test("deleting a project ends the shells of its threads", async () => {
    const root = join(dir, "doomed")
    execFileSync("git", ["init", "-q", "-b", "main", root])
    const project = result(await invoke("projects.create", { name: "doomed", rootPath: root, setupScript: null }))
    const thread = result(await invoke("threads.create", { projectId: project.id }))
    result(await invoke("terminal.open", { threadId: thread.id, cols: 80, rows: 24 }))
    result(await invoke("projects.delete", { id: project.id }))
    expect(result(await invoke("terminal.list", { threadId: thread.id }))).toStrictEqual([])
  })

  test("deleting a project tells every window its threads are gone", async () => {
    const root = join(dir, "removed-with-threads")
    execFileSync("git", ["init", "-q", "-b", "main", root])
    const project = result(await invoke("projects.create", { name: "removed", rootPath: root, setupScript: null }))
    const thread = result(await invoke("threads.create", { projectId: project.id }))
    electron.pushes.length = 0
    result(await invoke("projects.delete", { id: project.id }))
    expect(pushed()).toContainEqual({ type: "thread.removed", id: thread.id })
  })

  test("attaching a terminal refuses offsets that are not character counts", async () => {
    const project = result(await invoke("projects.list", undefined))[0]!
    const thread = result(await invoke("threads.create", { projectId: project.id }))
    const session = result(await invoke("terminal.open", { threadId: thread.id, cols: 80, rows: 24 }))
    for (const since of [-1, 1.5, Number.NaN])
      expect(failure(await invoke("terminal.attach", { id: session.id, since })).tag).toBe("SchemaError")
    expect(result(await invoke("terminal.attach", { id: session.id, since: null }))).toMatchObject({
      session,
      offset: 0,
    })
    result(await invoke("terminal.close", { id: session.id }))
  })
})

describe("sub-agents over rpc", () => {
  test("sub-agent progress is pushed and listed but stays out of the transcript", async () => {
    const project = result(await invoke("projects.list", undefined))[0]!
    const thread = result(await invoke("threads.create", { projectId: project.id }))
    electron.pushes.length = 0
    result(await invoke("threads.send", { threadId: thread.id, prompt: "spawn one" }))
    await expect
      .poll(async () => result(await invoke("subagents.list", { threadId: thread.id }))[0]?.status)
      .toBe("completed")

    expect(result(await invoke("subagents.list", { threadId: thread.id }))).toStrictEqual([
      { ...subagent, status: "completed", summary: "218 files", lastTool: "Bash", toolUses: 1, tokens: 14310 },
    ])
    const pushes = pushed().filter((event) => event.type === "thread.subagents")
    expect(pushes.map((event) => event.type === "thread.subagents" && event.subagents[0]?.status)).toStrictEqual([
      "running",
      "completed",
    ])
    const transcriptEvents = pushed().flatMap((event) => (event.type === "thread.event" ? [event.event.type] : []))
    expect(transcriptEvents).toStrictEqual(["text_delta", "turn_completed"])
    expect(result(await invoke("subagents.list", { threadId: "other" }))).toStrictEqual([])
  })

  test("a sub-agent still running when its turn ends is stopped", async () => {
    const project = result(await invoke("projects.list", undefined))[0]!
    const thread = result(await invoke("threads.create", { projectId: project.id }))
    result(await invoke("threads.send", { threadId: thread.id, prompt: "simulate a crash mid sub-agent" }))
    await expect
      .poll(async () => result(await invoke("subagents.list", { threadId: thread.id }))[0]?.status)
      .toBe("stopped")
    expect(result(await invoke("subagents.list", { threadId: thread.id }))[0]?.endedAt).not.toBeNull()
  })
})

describe("stopping a sub-agent over rpc", () => {
  test("stops one sub-agent while its turn keeps running", async () => {
    heldTurn = Promise.withResolvers()
    const project = result(await invoke("projects.list", undefined))[0]!
    const thread = result(await invoke("threads.create", { projectId: project.id }))
    result(await invoke("threads.send", { threadId: thread.id, prompt: "simulate a held sub-agent" }))
    await expect
      .poll(async () => result(await invoke("subagents.list", { threadId: thread.id }))[0]?.status)
      .toBe("running")

    result(await invoke("subagents.stop", { threadId: thread.id, subagentId: subagent.id }))
    expect(stoppedSubagents).toContainEqual({ threadId: thread.id, subagentId: subagent.id })
    const [stopped] = result(await invoke("subagents.list", { threadId: thread.id }))
    expect(stopped?.status).toBe("stopped")
    expect(stopped?.endedAt).not.toBeNull()
    expect((await threadOf(thread.id)).status).toBe("running")

    heldTurn.resolve()
    await expect.poll(async () => (await threadOf(thread.id)).status).toBe("idle")
  })
})

describe("forking over rpc", () => {
  test("goes on from the chosen turn in a new thread whose first turn forks the session", async () => {
    const project = result(await invoke("projects.list", undefined))[0]!
    const source = result(await invoke("threads.create", { projectId: project.id }))
    result(await invoke("threads.send", { threadId: source.id, prompt: "simulate a forkable turn" }))
    const transcript = async (threadId: string) => result(await invoke("threads.transcript", { threadId })).messages
    await expect
      .poll(async () => (await transcript(source.id)).at(-1)?.forkPoint)
      .toStrictEqual({
        sessionId: "source-session",
        checkpoint: "turn-1",
        owner: { provider: "claude", accountId: null },
      })
    const reply = (await transcript(source.id)).at(-1)!

    const fork = result(await invoke("threads.fork", { threadId: source.id, messageId: reply.id }))
    expect(fork.worktreeId).toBe(source.worktreeId)
    expect((await transcript(fork.id)).map((message) => message.parts)).toStrictEqual(
      (await transcript(source.id)).map((message) => message.parts),
    )

    turnResumes.length = 0
    turnPrompts.length = 0
    result(await invoke("threads.send", { threadId: fork.id, prompt: "simulate a session" }))
    await expect.poll(() => turnResumes).toStrictEqual([{ resumeSessionId: "source-session", forkAt: "turn-1" }])
    expect(turnPrompts).toStrictEqual(["simulate a session"])
    await expect.poll(async () => (await transcript(fork.id)).at(-1)?.completedAt).not.toBeNull()
    result(await invoke("threads.send", { threadId: fork.id, prompt: "simulate a session" }))
    await expect.poll(() => turnResumes.at(-1)).toStrictEqual({ resumeSessionId: boundSession, forkAt: null })
  })

  test("takes the session it forks from to the account an unsent fork switches to", async () => {
    const spare = result(await invoke("accounts.create", newAccount("claude", "Fork spare")))
    const spareHome = { dir: join(dir, "homes", "fork spare"), binary: "claude" }
    const project = result(await invoke("projects.list", undefined))[0]!
    const source = result(await invoke("threads.create", { projectId: project.id }))
    result(await invoke("threads.send", { threadId: source.id, prompt: "simulate a forkable turn" }))
    const transcript = async (threadId: string) => result(await invoke("threads.transcript", { threadId })).messages
    await expect.poll(async () => (await transcript(source.id)).at(-1)?.forkPoint ?? null).not.toBeNull()
    const fork = result(
      await invoke("threads.fork", { threadId: source.id, messageId: (await transcript(source.id)).at(-1)!.id }),
    )

    copiedSessions.length = 0
    turnHomes.length = 0
    turnResumes.length = 0
    result(await invoke("threads.switchAccount", { id: fork.id, accountId: spare.id }))
    expect(copiedSessions).toStrictEqual([{ sessionId: "source-session", from: null, to: spareHome }])
    result(await invoke("threads.send", { threadId: fork.id, prompt: "simulate a session" }))
    await expect.poll(() => turnHomes).toStrictEqual([spareHome])
    expect(turnResumes).toStrictEqual([{ resumeSessionId: "source-session", forkAt: "turn-1" }])
  })

  test("drops an unsent fork's source session when the fork switches agents", async () => {
    const project = result(await invoke("projects.list", undefined))[0]!
    const source = result(await invoke("threads.create", { projectId: project.id }))
    result(await invoke("threads.send", { threadId: source.id, prompt: "simulate a forkable turn" }))
    const transcript = async (threadId: string) => result(await invoke("threads.transcript", { threadId })).messages
    await expect.poll(async () => (await transcript(source.id)).at(-1)?.forkPoint ?? null).not.toBeNull()
    const fork = result(
      await invoke("threads.fork", { threadId: source.id, messageId: (await transcript(source.id)).at(-1)!.id }),
    )

    expect(result(await invoke("threads.update", { id: fork.id, provider: "codex" })).forkedFrom).toBeNull()
    expect(result(await invoke("threads.update", { id: fork.id, provider: "claude" })).forkedFrom).toBeNull()
    turnResumes.length = 0
    turnPrompts.length = 0
    result(await invoke("threads.send", { threadId: fork.id, prompt: "simulate a session" }))
    await expect.poll(() => turnResumes).toStrictEqual([{ resumeSessionId: null, forkAt: null }])
    expect(turnPrompts).toStrictEqual([
      expect.stringMatching(/^<conversation_handoff>\n[\s\S]*\n\nsimulate a session$/),
    ])
  })

  test("forks a copied turn in the account whose session ran it", async () => {
    const spare = result(await invoke("accounts.create", newAccount("claude", "Later account")))
    const project = result(await invoke("projects.list", undefined))[0]!
    const source = result(await invoke("threads.create", { projectId: project.id }))
    result(await invoke("threads.send", { threadId: source.id, prompt: "simulate a forkable turn" }))
    const transcript = async (threadId: string) => result(await invoke("threads.transcript", { threadId })).messages
    await expect.poll(async () => (await transcript(source.id)).at(-1)?.forkPoint ?? null).not.toBeNull()
    const sourceReply = (await transcript(source.id)).at(-1)!
    const middle = result(await invoke("threads.fork", { threadId: source.id, messageId: sourceReply.id }))
    result(await invoke("threads.send", { threadId: middle.id, prompt: "simulate a session" }))
    await expect.poll(async () => (await transcript(middle.id)).at(-1)?.completedAt ?? null).not.toBeNull()
    result(await invoke("threads.switchAccount", { id: middle.id, accountId: spare.id }))

    const copiedReply = (await transcript(middle.id)).find((message) => message.forkPoint !== null)!
    const fork = result(await invoke("threads.fork", { threadId: middle.id, messageId: copiedReply.id }))
    expect(fork.accountId).toBeNull()
    turnHomes.length = 0
    turnResumes.length = 0
    result(await invoke("threads.send", { threadId: fork.id, prompt: "simulate a session" }))
    await expect.poll(() => turnHomes).toStrictEqual([null])
    expect(turnResumes).toStrictEqual([{ resumeSessionId: "source-session", forkAt: "turn-1" }])
  })
})

describe("token usage over rpc", () => {
  test("is null until a turn binds a session, then comes from that session's transcripts", async () => {
    const project = result(await invoke("projects.list", undefined))[0]!
    const thread = result(await invoke("threads.create", { projectId: project.id }))
    expect(result(await invoke("threads.usage", { threadId: thread.id }))).toBeNull()

    result(await invoke("threads.send", { threadId: thread.id, prompt: "simulate a session" }))
    await expect
      .poll(async () => result(await invoke("threads.usage", { threadId: thread.id })))
      .toStrictEqual(sessionUsage)
  })
})

describe("plan limits over rpc", () => {
  test("lists every login and added account, with null limits for one that cannot answer", async () => {
    const personal = result(await invoke("accounts.create", newAccount("claude", "Personal")))
    const work = result(await invoke("accounts.create", newAccount("codex", "Work")))
    const listed = result(await invoke("limits.list", undefined))
    expect(listed.filter((entry) => [null, personal.id, work.id].includes(entry.accountId))).toStrictEqual([
      { provider: "claude", accountId: null, limits: claudeLimits },
      { provider: "claude", accountId: personal.id, limits: null },
      { provider: "codex", accountId: null, limits: null },
      { provider: "codex", accountId: work.id, limits: null },
      { provider: "muse", accountId: null, limits: null },
    ])
  })
})

const newAccount = (provider: "claude" | "codex", name: string) => ({
  provider,
  name,
  configDir: join(dir, "homes", name.toLowerCase()),
  binary: provider,
})

const cachedLogin = (label: string) => existsSync(join(dir, "cache", `${label}.json`))

const history = () => join(dir, "history")
const inHistory = (...args: Array<string>) =>
  execFileSync("git", ["-C", history(), "-c", "user.email=t@t", "-c", "user.name=Kalan", ...args], {
    encoding: "utf8",
  }).trim()
const commitInHistory = (file: string, message: string) => {
  writeFileSync(join(history(), file), message)
  inHistory("add", file)
  inHistory("commit", "-q", "-m", message)
  return inHistory("rev-parse", "HEAD")
}

describe("git history over rpc", () => {
  test("lists a branch, a merge and a tag, and shows a merge against its first parent", async () => {
    execFileSync("git", ["init", "-q", "-b", "main", history()])
    const base = commitInHistory("a.txt", "init")
    inHistory("switch", "-q", "-c", "feat/x")
    const feature = commitInHistory("b.txt", "feat: add b")
    inHistory("switch", "-q", "main")
    const mainline = commitInHistory("c.txt", "fix: add c")
    inHistory("merge", "-q", "--no-ff", "-m", "Merge branch 'feat/x'", "feat/x")
    const merge = inHistory("rev-parse", "HEAD")
    inHistory("tag", "v1")
    result(await invoke("projects.create", { name: "history", rootPath: history(), setupScript: null }))

    const commits = result(await invoke("git.log", { root: history() }))
    expect(commits).toHaveLength(4)
    expect(commits[0]).toMatchObject({
      hash: merge,
      parents: [mainline, feature],
      subject: "Merge branch 'feat/x'",
      author: "Kalan",
      refs: ["HEAD", "main", "tag: v1"],
    })
    expect(commits.find((item) => item.hash === feature)?.refs).toStrictEqual(["feat/x"])
    expect(commits.at(-1)).toMatchObject({ hash: base, parents: [] })
    expect(result(await invoke("git.log", { root: history(), limit: 2 }))).toHaveLength(2)

    const diff = result(await invoke("git.show", { root: history(), hash: merge }))
    expect(diff.files).toStrictEqual([{ path: "b.txt", status: "added" }])
    expect(diff.patch).toContain("diff --git a/b.txt b/b.txt")
  })

  test("reads a live worktree but refuses removed ones, unknown paths and option-like hashes", async () => {
    const project = result(await invoke("projects.list", undefined)).find((item) => item.rootPath === history())!
    const worktree = result(
      await invoke("worktrees.create", { projectId: project.id, branch: "kk/history", baseRef: "main" }),
    )
    expect(result(await invoke("git.log", { root: worktree.path }))[0]?.refs).toContain("kk/history")

    result(await invoke("worktrees.remove", { id: worktree.id, deleteBranch: "force" }))
    expect(failure(await invoke("git.log", { root: worktree.path })).tag).toBe("UnknownRootError")
    expect(failure(await invoke("git.log", { root: dir })).tag).toBe("UnknownRootError")
    expect(failure(await invoke("git.show", { root: history(), hash: "--output=/tmp/x" })).tag).toBe("SchemaError")
  })
})

describe("limited threads over rpc", () => {
  test("persists a limit, schedules and cancels once, then allows a normal retry", async () => {
    const project = result(await invoke("projects.list", undefined))[0]!
    const thread = result(await invoke("threads.create", { projectId: project.id }))
    result(await invoke("threads.send", { threadId: thread.id, prompt: "simulate usage limit" }))
    await expect
      .poll(async () => result(await invoke("threads.list", undefined)).find((item) => item.id === thread.id)?.status)
      .toBe("limited")
    const scheduled = result(await invoke("threads.resumeAtReset", { id: thread.id, enabled: true }))
    expect(scheduled.usageLimit).toMatchObject({ kind: "usage", reset: { autoResume: true } })
    const cancelled = result(await invoke("threads.resumeAtReset", { id: thread.id, enabled: false }))
    expect(cancelled.usageLimit).toMatchObject({ kind: "usage", reset: { autoResume: false } })
    await expect
      .poll(
        async () => result(await invoke("threads.transcript", { threadId: thread.id })).messages.at(-1)?.completedAt,
      )
      .not.toBeNull()
    result(await invoke("threads.send", { threadId: thread.id, prompt: "retry" }))
    await expect
      .poll(async () => result(await invoke("threads.list", undefined)).find((item) => item.id === thread.id)?.status)
      .toBe("idle")
    expect(result(await invoke("threads.list", undefined)).find((item) => item.id === thread.id)?.usageLimit).toBeNull()
    expect(failure(await invoke("threads.resumeAtReset", { id: thread.id, enabled: true })).tag).toBe("AgentError")
  })

  test("resends the last prompt once its limit has reset", async () => {
    const project = result(await invoke("projects.list", undefined))[0]!
    const thread = result(await invoke("threads.create", { projectId: project.id }))
    const current = async () => result(await invoke("threads.list", undefined)).find((item) => item.id === thread.id)
    const prompts = async () =>
      result(await invoke("threads.transcript", { threadId: thread.id })).messages.filter(
        (message) => message.role === "user",
      ).length
    result(await invoke("threads.send", { threadId: thread.id, prompt: "simulate a passed usage limit" }))
    await expect.poll(async () => (await current())?.status).toBe("limited")

    result(await invoke("threads.resumeAtReset", { id: thread.id, enabled: true }))
    await expect.poll(prompts, { timeout: 5_000 }).toBe(2)
    await expect.poll(async () => (await current())?.status).toBe("idle")
    result(await invoke("threads.delete", { id: thread.id }))
  })

  test("continues a limited thread on another account with its session and last prompt", async () => {
    const spare = result(await invoke("accounts.create", newAccount("claude", "Spare")))
    const codex = result(await invoke("accounts.create", newAccount("codex", "Elsewhere")))
    const project = result(await invoke("projects.list", undefined))[0]!
    const thread = result(await invoke("threads.create", { projectId: project.id }))
    const statusOf = async () =>
      result(await invoke("threads.list", undefined)).find((item) => item.id === thread.id)?.status
    result(await invoke("threads.send", { threadId: thread.id, prompt: "simulate a session" }))
    await expect.poll(statusOf).toBe("idle")
    result(await invoke("threads.send", { threadId: thread.id, prompt: "simulate usage limit" }))
    await expect.poll(statusOf).toBe("limited")

    expect(failure(await invoke("threads.switchAccount", { id: thread.id, accountId: codex.id })).tag).toBe(
      "NotFoundError",
    )
    copiedSessions.length = 0
    turnHomes.length = 0
    const switched = result(await invoke("threads.switchAccount", { id: thread.id, accountId: spare.id, resend: true }))
    expect(switched.accountId).toBe(spare.id)
    const spareHome = { dir: join(dir, "homes", "spare"), binary: "claude" }
    expect(copiedSessions).toStrictEqual([{ sessionId: boundSession, from: null, to: spareHome }])
    await expect.poll(() => turnHomes).toStrictEqual([spareHome])
    await expect.poll(statusOf).toBe("idle")
    const prompts = result(await invoke("threads.transcript", { threadId: thread.id }))
      .messages.filter((message) => message.role === "user")
      .map((message) => message.parts)
    expect(prompts.slice(-2)).toStrictEqual([
      [{ type: "text", text: "simulate usage limit" }],
      [{ type: "text", text: "simulate usage limit" }],
    ])
    result(await invoke("threads.delete", { id: thread.id }))
  })

  test("refuses to switch accounts while a turn runs", async () => {
    const spare = result(await invoke("accounts.create", newAccount("claude", "Busy")))
    const project = result(await invoke("projects.list", undefined))[0]!
    const thread = result(await invoke("threads.create", { projectId: project.id }))
    heldTurn = Promise.withResolvers()
    result(await invoke("threads.send", { threadId: thread.id, prompt: "simulate a held turn" }))
    expect(failure(await invoke("threads.switchAccount", { id: thread.id, accountId: spare.id })).tag).toBe(
      "AgentError",
    )
    heldTurn.resolve()
    await pushedEventually(
      (event) => event.type === "thread.updated" && event.thread.id === thread.id && event.thread.status === "idle",
    )
    expect(result(await invoke("threads.switchAccount", { id: thread.id, accountId: spare.id })).accountId).toBe(
      spare.id,
    )
    result(await invoke("threads.delete", { id: thread.id }))
  })

  test("decodes the schedule request before the handler sees it", async () => {
    const response = await electron.handlers.get(RPC_CHANNEL)!(
      { sender: {}, senderFrame: mainFrame },
      {
        method: "threads.resumeAtReset",
        payload: { id: "thread", enabled: "true" },
      },
    )
    expect(response).toMatchObject({ error: { tag: "SchemaError" } })
  })
})

describe("compact transcripts over rpc", () => {
  test("leave out tool outputs and file diffs only when asked", async () => {
    const root = join(dir, "compact")
    execFileSync("git", ["init", "-q", "-b", "main", root])
    const project = result(await invoke("projects.create", { name: "compact", rootPath: root, setupScript: null }))
    const thread = result(await invoke("threads.create", { projectId: project.id }))
    result(await invoke("threads.send", { threadId: thread.id, prompt: "simulate a tool call" }))
    await expect.poll(async () => (await threadOf(thread.id)).status).toBe("idle")
    const parts = async (compact?: boolean) =>
      result(await invoke("threads.transcript", { threadId: thread.id, compact })).messages.at(-1)?.parts

    expect(await parts()).toMatchObject([
      { type: "tool_call", name: "Bash", output: "a.txt\nb.txt" },
      { type: "file_change", path: "a.txt", diff: "@@ -0,0 +1 @@\n+a" },
      { type: "text", text: "Listed and edited." },
    ])
    const compact = await parts(true)
    expect(compact).toMatchObject([
      { type: "tool_call", name: "Bash", status: "done" },
      { type: "file_change", path: "a.txt", diff: "" },
      { type: "text", text: "Listed and edited." },
    ])
    expect(compact?.[0]).not.toHaveProperty("output")

    const all = result(await invoke("threads.transcript", { threadId: thread.id })).messages.map((m) => m.id)
    const newest = result(await invoke("threads.transcript", { threadId: thread.id, compact: true, page: {} }))
    expect(newest.messages.map((m) => m.id)).toStrictEqual(all)
    expect(newest.hasEarlier).toBe(false)
    const older = result(
      await invoke("threads.transcript", { threadId: thread.id, compact: true, page: { before: all.at(-1)! } }),
    )
    expect(older.messages.map((m) => m.id)).toStrictEqual(all.slice(0, -1))
  })
})

const threadOf = async (id: string) => result(await invoke("threads.list", undefined)).find((item) => item.id === id)!

const userTexts = async (threadId: string) =>
  result(await invoke("threads.transcript", { threadId }))
    .messages.filter((message) => message.role === "user")
    .flatMap((message) => message.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])))

const assistantTexts = async (threadId: string) =>
  result(await invoke("threads.transcript", { threadId }))
    .messages.filter((message) => message.role === "assistant")
    .map((message) => message.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join(""))

const wake = (threadId: string, text: string) =>
  Effect.runSync(
    Queue.offer(claudeWakes, {
      threadId,
      sessionId: boundSession,
      events: Stream.make({ type: "text_delta", text }, { type: "turn_completed" }),
      discard: Effect.void,
    }),
  )

describe("turns the agent starts over rpc", () => {
  test("shows a turn the agent starts by itself as a reply of its own", async () => {
    const project = result(await invoke("projects.list", undefined))[0]!
    const thread = result(await invoke("threads.create", { projectId: project.id }))
    result(await invoke("threads.send", { threadId: thread.id, prompt: "simulate a session" }))
    await expect.poll(async () => (await threadOf(thread.id)).status).toBe("idle")
    electron.pushes.length = 0

    wake(thread.id, "The sub-agent finished.")
    await expect.poll(() => assistantTexts(thread.id)).toStrictEqual(["", "The sub-agent finished."])
    await expect.poll(async () => (await threadOf(thread.id)).status).toBe("idle")
    const statuses = pushed().flatMap((event) =>
      event.type === "thread.updated" && event.thread.id === thread.id ? [event.thread.status] : [],
    )
    expect(statuses).toStrictEqual(["running", "idle"])
    expect(await userTexts(thread.id)).toStrictEqual(["simulate a session"])
  })

  test("unarchives a thread when the user sends to it", async () => {
    const project = result(await invoke("projects.list", undefined))[0]!
    const thread = result(await invoke("threads.create", { projectId: project.id }))
    result(await invoke("threads.archive", { threadId: thread.id }))
    electron.pushes.length = 0

    result(await invoke("threads.send", { threadId: thread.id, prompt: "simulate a session" }))
    await expect.poll(async () => (await threadOf(thread.id)).status).toBe("idle")
    expect(await userTexts(thread.id)).toStrictEqual(["simulate a session"])
    const statuses = pushed().flatMap((event) =>
      event.type === "thread.updated" && event.thread.id === thread.id ? [event.thread.status] : [],
    )
    expect(statuses[0]).toBe("idle")
  })

  test("discards a wake for an archived thread before reading its events", async () => {
    const project = result(await invoke("projects.list", undefined))[0]!
    const thread = result(await invoke("threads.create", { projectId: project.id }))
    result(await invoke("threads.archive", { threadId: thread.id }))
    const discard = vi.fn()
    Effect.runSync(
      Queue.offer(claudeWakes, {
        threadId: thread.id,
        sessionId: boundSession,
        events: Stream.never,
        discard: Effect.sync(discard),
      }),
    )
    await expect.poll(() => discard.mock.calls.length).toBe(1)
    expect((await threadOf(thread.id)).status).toBe("archived")
    expect(await assistantTexts(thread.id)).toStrictEqual([])
  })

  test("waits for workspace changes before admitting a wake", async () => {
    const project = result(await invoke("projects.list", undefined))[0]!
    const thread = result(await invoke("threads.create", { projectId: project.id }))
    const worktrees = await runtime.runPromise(Worktrees.Worktrees)
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const archiving = runtime.runPromise(
      worktrees.exclusive(
        Effect.gen(function* () {
          entered.resolve()
          yield* Effect.promise(() => release.promise)
          yield* Threads.Threads.use((threads) => threads.update({ id: thread.id, status: "archived" }))
        }),
      ),
    )
    await entered.promise
    const admission = vi.spyOn(worktrees, "exclusive")
    const discard = vi.fn()
    const storedMessages = () => runtime.runPromise(Messages.Messages.use((messages) => messages.list(thread.id)))
    try {
      Effect.runSync(
        Queue.offer(claudeWakes, {
          threadId: thread.id,
          sessionId: boundSession,
          events: Stream.empty,
          discard: Effect.sync(discard),
        }),
      )
      await expect.poll(async () => admission.mock.calls.length > 0 || (await storedMessages()).length > 0).toBe(true)
      expect(await storedMessages()).toStrictEqual([])
      release.resolve()
      await archiving
      await expect.poll(() => discard.mock.calls.length).toBe(1)
      expect((await threadOf(thread.id)).status).toBe("archived")
    } finally {
      release.resolve()
      await archiving
      admission.mockRestore()
    }
  })

  test("queues a message sent while it runs", async () => {
    const held = Promise.withResolvers<void>()
    const project = result(await invoke("projects.list", undefined))[0]!
    const thread = result(await invoke("threads.create", { projectId: project.id }))
    result(await invoke("threads.send", { threadId: thread.id, prompt: "simulate a session" }))
    await expect.poll(async () => (await threadOf(thread.id)).status).toBe("idle")
    Effect.runSync(
      Queue.offer(claudeWakes, {
        threadId: thread.id,
        sessionId: boundSession,
        discard: Effect.void,
        events: Stream.fromEffect(Effect.promise(() => held.promise)).pipe(
          Stream.flatMap(() => Stream.make<Array<AgentEvent>>({ type: "turn_completed" })),
        ),
      }),
    )
    await expect.poll(async () => (await threadOf(thread.id)).status).toBe("running")
    result(await invoke("threads.queue", { threadId: thread.id, text: "then the docs" }))
    expect((await threadOf(thread.id)).queue.map((queued) => queued.text)).toStrictEqual(["then the docs"])

    held.resolve()
    await expect.poll(() => userTexts(thread.id)).toStrictEqual(["simulate a session", "then the docs"])
    await expect.poll(async () => (await threadOf(thread.id)).status).toBe("idle")
  })

  test("waits for the running turn before it starts", async () => {
    heldTurn = Promise.withResolvers()
    const project = result(await invoke("projects.list", undefined))[0]!
    const thread = result(await invoke("threads.create", { projectId: project.id }))
    result(await invoke("threads.send", { threadId: thread.id, prompt: "simulate a session" }))
    await expect.poll(async () => (await threadOf(thread.id)).status).toBe("idle")
    result(await invoke("threads.send", { threadId: thread.id, prompt: "simulate a held turn" }))
    wake(thread.id, "The sub-agent finished.")
    await expect.poll(async () => (await threadOf(thread.id)).status).toBe("running")
    expect(await assistantTexts(thread.id)).toStrictEqual(["", ""])

    heldTurn.resolve()
    await expect
      .poll(() => assistantTexts(thread.id))
      .toStrictEqual(["", "Spawned one sub-agent.", "The sub-agent finished."])
    await expect.poll(async () => (await threadOf(thread.id)).status).toBe("idle")
  })
})

describe("queued messages over rpc", () => {
  test("runs queued messages in order once the turn completes", async () => {
    heldTurn = Promise.withResolvers()
    const project = result(await invoke("projects.list", undefined))[0]!
    const thread = result(await invoke("threads.create", { projectId: project.id }))
    result(await invoke("threads.send", { threadId: thread.id, prompt: "simulate a held turn" }))
    result(await invoke("threads.queue", { threadId: thread.id, text: "then the tests" }))
    result(await invoke("threads.queue", { threadId: thread.id, text: "then the docs" }))
    expect((await threadOf(thread.id)).queue.map((queued) => queued.text)).toStrictEqual([
      "then the tests",
      "then the docs",
    ])
    expect(await userTexts(thread.id)).toStrictEqual(["simulate a held turn"])

    heldTurn.resolve()
    await expect
      .poll(() => userTexts(thread.id))
      .toStrictEqual(["simulate a held turn", "then the tests", "then the docs"])
    await expect.poll(async () => (await threadOf(thread.id)).status).toBe("idle")
    expect((await threadOf(thread.id)).queue).toStrictEqual([])
  })

  test("keeps the queue when the user stops the turn, and hands a message back once", async () => {
    heldTurn = Promise.withResolvers()
    const project = result(await invoke("projects.list", undefined))[0]!
    const thread = result(await invoke("threads.create", { projectId: project.id }))
    result(await invoke("threads.send", { threadId: thread.id, prompt: "simulate a held turn" }))
    result(await invoke("threads.queue", { threadId: thread.id, text: "after the stop" }))
    result(await invoke("threads.interrupt", { threadId: thread.id }))
    heldTurn.resolve()
    await expect.poll(async () => (await threadOf(thread.id)).status).toBe("idle")
    expect(await userTexts(thread.id)).toStrictEqual(["simulate a held turn"])

    const [queued] = (await threadOf(thread.id)).queue
    expect(result(await invoke("threads.unqueue", { threadId: thread.id, id: queued!.id }))).toMatchObject({
      text: "after the stop",
    })
    expect(result(await invoke("threads.unqueue", { threadId: thread.id, id: queued!.id }))).toBeNull()
    expect((await threadOf(thread.id)).queue).toStrictEqual([])
  })

  test("sends right away when nothing is running", async () => {
    const project = result(await invoke("projects.list", undefined))[0]!
    const thread = result(await invoke("threads.create", { projectId: project.id }))
    result(await invoke("threads.queue", { threadId: thread.id, text: "simulate a session" }))
    await expect.poll(() => userTexts(thread.id)).toStrictEqual(["simulate a session"])
    expect((await threadOf(thread.id)).queue).toStrictEqual([])
  })
})

describe("agent questions over rpc", () => {
  test("forgets unanswered questions when a turn ends before question_resolved", async () => {
    const project = result(await invoke("projects.list", undefined))[0]!
    const thread = result(await invoke("threads.create", { projectId: project.id }))
    result(await invoke("threads.send", { threadId: thread.id, prompt: "simulate unanswered question" }))
    await expect
      .poll(async () => result(await invoke("threads.list", undefined)).find((item) => item.id === thread.id)?.status)
      .toBe("idle")
    await expect
      .poll(async () => result(await invoke("threads.transcript", { threadId: thread.id })).questions)
      .toStrictEqual([])
  })

  test("decodes answers and refuses subframes before the question responder runs", async () => {
    const handler = electron.handlers.get(RPC_CHANNEL)!
    const invalid = await handler(
      { sender: {}, senderFrame: mainFrame },
      { method: "questions.respond", payload: { requestId: "q", answers: { choice: 42 } } },
    )
    expect(failure(invalid as RpcEnvelope<unknown>).tag).toBe("SchemaError")
    expect(
      failure(await invoke("questions.respond", { requestId: "q", answers: {} }, { url: appUrl, parent: mainFrame }))
        .tag,
    ).toBe("UntrustedSender")
    result(await invoke("questions.respond", { requestId: "unknown", answers: { choice: ["blue"] } }))
  })
})

describe("agent approvals over rpc", () => {
  test("decodes the note and hands it to the provider with the decision", async () => {
    heldTurn = Promise.withResolvers()
    const project = result(await invoke("projects.list", undefined))[0]!
    const thread = result(await invoke("threads.create", { projectId: project.id }))
    result(await invoke("threads.send", { threadId: thread.id, prompt: "simulate a held approval" }))
    await expect
      .poll(async () => result(await invoke("threads.transcript", { threadId: thread.id })).approvals)
      .toHaveLength(1)
    const requestId = `approval-${thread.id}`

    const handler = electron.handlers.get(RPC_CHANNEL)!
    const invalid = await handler(
      { sender: {}, senderFrame: mainFrame },
      { method: "approvals.respond", payload: { requestId, decision: "deny", note: 42 } },
    )
    expect(failure(invalid as RpcEnvelope<unknown>).tag).toBe("SchemaError")
    result(await invoke("approvals.respond", { requestId, decision: "deny", note: "use pnpm" }))
    expect(approvalAnswers).toStrictEqual([{ requestId, decision: "deny", note: "use pnpm" }])

    heldTurn.resolve()
    await expect
      .poll(async () => result(await invoke("threads.list", undefined)).find((item) => item.id === thread.id)?.status)
      .toBe("idle")
  })
})

describe("agent accounts over rpc", () => {
  test("decodes provider IDs and refuses account requests from subframes", async () => {
    const handler = electron.handlers.get(RPC_CHANNEL)!
    for (const payload of [{}, { provider: "futureProvider" }, { provider: 123 }]) {
      const response = await handler({ sender: {}, senderFrame: mainFrame }, { method: "agents.account", payload })
      expect(failure(response as RpcEnvelope<unknown>).tag).toBe("SchemaError")
    }
    expect(
      failure(
        await invoke("agents.account", { provider: "claude", accountId: null }, { url: appUrl, parent: mainFrame }),
      ).tag,
    ).toBe("UntrustedSender")
    expect(result(await invoke("agents.account", { provider: "claude", accountId: null }))).toStrictEqual({
      type: "signedOut",
    })
  })

  test("refuses account names that are blank, padded or long, and homes or binaries that are not paths", async () => {
    for (const name of ["", "  ", " Work", "x".repeat(81)]) {
      expect(failure(await invoke("accounts.create", { ...newAccount("codex", "Work"), name })).tag).toBe("SchemaError")
    }
    for (const configDir of ["", "work", "~work", " /tmp/work"]) {
      expect(failure(await invoke("accounts.create", { ...newAccount("codex", "Work"), configDir })).tag).toBe(
        "SchemaError",
      )
    }
    for (const binary of ["", " codex"]) {
      expect(failure(await invoke("accounts.create", { ...newAccount("codex", "Work"), binary })).tag).toBe(
        "SchemaError",
      )
    }
    expect(
      failure(await invoke("accounts.create", { ...newAccount("codex", "Work"), provider: "gemini" as "codex" })).tag,
    ).toBe("SchemaError")
    expect(
      failure(await invoke("accounts.create", { ...newAccount("codex", "Work"), provider: "muse" as "codex" })).tag,
    ).toBe("SchemaError")
  })

  test("runs a thread on its account and refuses to remove the account while the thread exists", async () => {
    const account = result(await invoke("accounts.create", newAccount("codex", "Work")))
    expect(result(await invoke("accounts.rename", { id: account.id, name: "Client work" })).name).toBe("Client work")
    expect(result(await invoke("accounts.list", undefined))).toContainEqual({ ...account, name: "Client work" })
    expect(result(await invoke("agents.account", { provider: "codex", accountId: account.id }))).toMatchObject({
      email: "work@example.com",
    })

    const project = result(await invoke("projects.list", undefined))[0]!
    const thread = result(await invoke("threads.create", { projectId: project.id }))
    result(await invoke("threads.update", { id: thread.id, provider: "codex" }))
    const onCodex = result(await invoke("threads.switchAccount", { id: thread.id, accountId: account.id }))
    expect(onCodex.accountId).toBe(account.id)
    turnHomes.length = 0
    result(await invoke("threads.send", { threadId: thread.id, prompt: "hello" }))
    await pushedEventually(
      (event) => event.type === "thread.updated" && event.thread.id === thread.id && event.thread.status === "idle",
    )
    expect(turnHomes).toStrictEqual([{ dir: join(dir, "homes", "work"), binary: "codex" }])

    expect(failure(await invoke("accounts.delete", { id: account.id }))).toMatchObject({ tag: "AccountInUseError" })
    result(await invoke("threads.delete", { id: thread.id }))
    result(await invoke("accounts.delete", { id: account.id }))
    expect(result(await invoke("accounts.list", undefined))).not.toContainEqual(
      expect.objectContaining({ id: account.id }),
    )
  })

  test("drops an account's cached sign-in when it is renamed or removed", async () => {
    const account = result(await invoke("accounts.create", newAccount("codex", "Billing")))
    result(await invoke("agents.account", { provider: "codex", accountId: account.id }))
    expect(cachedLogin("billing_codex")).toBe(true)

    result(await invoke("accounts.rename", { id: account.id, name: "Invoices" }))
    expect(cachedLogin("billing_codex")).toBe(false)
    result(await invoke("agents.account", { provider: "codex", accountId: account.id }))
    expect(cachedLogin("invoices_codex")).toBe(true)

    result(await invoke("accounts.delete", { id: account.id }))
    expect(cachedLogin("invoices_codex")).toBe(false)
  })
})

const phone = (port: number, options?: { autoPong: boolean }) => {
  const socket = new WebSocket(remoteWebSocketUrl({ host: "127.0.0.1", port }), options)
  const frames: Array<ServerFrame> = []
  const watchers = new Set<() => void>()
  let closed: { code: number; reason: string } | null = null
  socket.on("message", (raw) => {
    frames.push(JSON.parse(String(raw)) as ServerFrame)
    for (const notify of watchers) notify()
  })
  socket.on("close", (code, reason) => {
    closed = { code, reason: String(reason) }
    for (const notify of watchers) notify()
  })
  const until = <A>(pick: () => A | undefined) =>
    new Promise<A>((resolve) => {
      const check = () => {
        const found = pick()
        if (found === undefined) return
        watchers.delete(check)
        resolve(found)
      }
      watchers.add(check)
      check()
    })
  const opened = new Promise<void>((resolve) => socket.once("open", resolve))
  let nextId = 1
  return {
    send: async (frame: ClientFrame | string) => {
      await opened
      socket.send(typeof frame === "string" ? frame : JSON.stringify(frame))
    },
    call: async <M extends RpcMethod>(method: M, payload: RpcRequestEncoded<M>, key?: string) => {
      const id = nextId++
      await opened
      socket.send(JSON.stringify({ type: "call", id, method, payload, ...(key && { key }) } satisfies ClientFrame))
      const frame = await until(() => frames.find((f) => f.type === "result" && f.id === id) ?? closed ?? undefined)
      if (!("type" in frame)) throw new Error(`socket closed before the answer: ${frame.code} ${frame.reason}`)
      return (frame as Extract<ServerFrame, { type: "result" }>).envelope as RpcEnvelope<RpcResponseEncoded<M>>
    },
    challenge: () => until(() => frames.find((f) => f.type === "challenge")),
    ready: () => until(() => frames.find((f) => f.type === "ready")),
    answered: (count: number) =>
      until(() => (frames.filter((f) => f.type === "result").length >= count ? true : undefined)),
    pong: (at: number) => until(() => frames.find((f) => f.type === "pong" && f.at === at)),
    pinged: new Promise<void>((resolve) => socket.once("ping", () => resolve())),
    event: (predicate: (event: PushEvent) => boolean) =>
      until(() => frames.find((f) => f.type === "event" && predicate(f.event as PushEvent))),
    closed: () => until(() => closed ?? undefined),
    frames,
    opened,
    socket,
  }
}

describe("remote mode", () => {
  let port = 0

  beforeAll(async () => {
    port = await unusedLoopbackPort()
    result(await invoke("settings.set", { remote: { enabled: true, bindHost: "127.0.0.1", port } }))
    await vi.waitFor(async () => expect(result(await invoke("remote.status", undefined)).listening).toBe(true))
  })

  test("refuses a call before auth and a wrong token", async () => {
    const early = phone(port)
    await early.send({ type: "call", id: 1, method: "projects.list", payload: undefined })
    expect((await early.closed()).code).toBe(RemoteAccess.CLOSE_MALFORMED_FRAME)

    const wrong = phone(port)
    await wrong.send({ type: "auth", token: "not-the-token" })
    expect((await wrong.closed()).code).toBe(RemoteAccess.CLOSE_UNAUTHORIZED)
  })

  test("the first frame is a challenge, and a proof of the token gets a ready that proves it back", async () => {
    const { token } = result(await invoke("remote.pairing", undefined))
    const proved = phone(port)
    const challenge = await proved.challenge()
    expect(proved.frames[0]).toBe(challenge)
    const nonce = newNonce()
    await proved.send({ type: "auth", nonce, proof: clientProof(token, challenge.nonce, nonce) })
    expect((await proved.ready()).proof).toBe(serverProof(token, nonce, challenge.nonce))
    expect(result(await proved.call("projects.list", undefined))).toBeInstanceOf(Array)
    proved.socket.close()
  })

  test("compresses frames for a client that offers permessage-deflate", async () => {
    const client = phone(port)
    await client.opened
    expect(client.socket.extensions).toContain("permessage-deflate")
    client.socket.close()
  })

  test("a wrong proof is refused like a wrong token", async () => {
    const forged = phone(port)
    const challenge = await forged.challenge()
    const nonce = newNonce()
    await forged.send({ type: "auth", nonce, proof: clientProof("not-the-token", challenge.nonce, nonce) })
    expect((await forged.closed()).code).toBe(RemoteAccess.CLOSE_UNAUTHORIZED)
  })

  test("a client that predates the challenge still connects with the token, and its ready proves nothing", async () => {
    const old = phone(port)
    await old.send({ type: "auth", token: result(await invoke("remote.pairing", undefined)).token })
    expect(await old.ready()).not.toHaveProperty("proof")
    old.socket.close()
  })

  test("rotating the token closes a socket that authenticated with a proof", async () => {
    const { token } = result(await invoke("remote.pairing", undefined))
    const proved = phone(port)
    const challenge = await proved.challenge()
    const nonce = newNonce()
    await proved.send({ type: "auth", nonce, proof: clientProof(token, challenge.nonce, nonce) })
    await proved.ready()
    result(await invoke("remote.rotateToken", undefined))
    expect((await proved.closed()).code).toBe(RemoteAccess.CLOSE_TOKEN_ROTATED)
  })

  test("a paired phone calls rpc, receives pushes and is refused desktop-only methods", async () => {
    const pairing = result(await invoke("remote.pairing", undefined))
    expect(pairing.port).toBe(port)
    expect(pairing.hosts).toEqual(["127.0.0.1"])

    const paired = phone(port)
    await paired.send({ type: "auth", token: pairing.token })
    await paired.ready()
    await vi.waitFor(async () => expect(result(await invoke("remote.status", undefined)).connected).toBe(1))

    const project = result(await paired.call("projects.list", undefined))[0] ?? (await createProject("remote-project"))

    const thread = result(await paired.call("threads.create", { projectId: project.id }))
    const push = await paired.event((event) => event.type === "thread.updated" && event.thread.id === thread.id)
    expect(push.type).toBe("event")

    expect(failure(await paired.call("dialog.pickFolder", undefined)).tag).toBe("DesktopOnly")
    expect(await paired.call("threads.interrupt", { threadId: thread.id })).toStrictEqual({})
    paired.socket.close()
  })

  test("a phone that watches threads hears their replies stream, and only how the others end", async () => {
    const paired = phone(port)
    await paired.send({ type: "auth", token: result(await invoke("remote.pairing", undefined)).token })
    expect((await paired.ready()).features).toContain("watch")
    const project = result(await paired.call("projects.list", undefined))[0] ?? (await createProject("remote-watch"))
    const shown = result(await paired.call("threads.create", { projectId: project.id }))
    const hidden = result(await paired.call("threads.create", { projectId: project.id }))
    const heard = (threadId: string) =>
      paired.frames.flatMap((frame) =>
        frame.type === "event" && frame.event.type === "thread.event" && frame.event.threadId === threadId
          ? [frame.event.event.type]
          : [],
      )

    await paired.send({ type: "watch", threadIds: [shown.id] })
    result(await paired.call("threads.send", { threadId: hidden.id, prompt: "simulate a tool call" }))
    result(await paired.call("threads.send", { threadId: shown.id, prompt: "simulate a tool call" }))
    await vi.waitFor(() => expect(heard(hidden.id)).toContain("turn_completed"))
    await vi.waitFor(() => expect(heard(shown.id)).toContain("turn_completed"))
    expect(heard(hidden.id)).toStrictEqual(["turn_completed"])
    expect(heard(shown.id)).toEqual(expect.arrayContaining(["tool_call_started", "text_delta"]))
    paired.socket.close()
  })

  test("a paired phone reads Linear issues, empty on a machine without a Linear key", async () => {
    const paired = phone(port)
    await paired.send({ type: "auth", token: result(await invoke("remote.pairing", undefined)).token })
    await paired.ready()
    expect(result(await paired.call("secrets.has", { name: "linear.apiKey" }))).toBe(false)
    expect(result(await paired.call("linear.issues", undefined))).toStrictEqual([])
    paired.socket.close()
  })

  test("closes a socket that sends a frame outside the protocol, before or after auth, without calling it unauthorized", async () => {
    const early = phone(port)
    await early.send("not json")
    expect((await early.closed()).code).toBe(RemoteAccess.CLOSE_MALFORMED_FRAME)

    const paired = phone(port)
    await paired.send({ type: "auth", token: result(await invoke("remote.pairing", undefined)).token })
    await paired.ready()
    await paired.send(JSON.stringify({ type: "call", id: "one", method: "projects.list" }))
    expect((await paired.closed()).code).toBe(RemoteAccess.CLOSE_MALFORMED_FRAME)
  })

  test("answers an unknown method and a ping on the same socket without closing it", async () => {
    const paired = phone(port)
    await paired.send({ type: "auth", token: result(await invoke("remote.pairing", undefined)).token })
    expect((await paired.ready()).features).toEqual(expect.arrayContaining(["heartbeat", "call-keys"]))

    expect(failure(await paired.call("no.such.method" as RpcMethod, undefined as never)).tag).toBe("SchemaError")
    await paired.send({ type: "ping", at: 42 })
    await paired.pong(42)
    expect(result(await paired.call("projects.list", undefined))).toBeInstanceOf(Array)
    paired.socket.close()
  })

  test("sends a transcript larger than the socket buffer next to another call without closing", async () => {
    const project = result(await invoke("projects.list", undefined))[0] ?? (await createProject("large-transcript"))
    const thread = result(await invoke("threads.create", { projectId: project.id }))
    await runtime.runPromise(
      Messages.Messages.use((messages) =>
        messages.insert({
          id: `${thread.id}-long`,
          threadId: thread.id,
          role: "assistant",
          parts: [{ type: "text", text: "x".repeat(9 * 1024 * 1024) }],
          createdAt: "2026-10-12T00:00:00.000Z",
          completedAt: "2026-10-12T00:00:00.000Z",
          usage: null,
          forkPoint: null,
        }),
      ),
    )
    const paired = phone(port)
    await paired.send({ type: "auth", token: result(await invoke("remote.pairing", undefined)).token })
    await paired.ready()

    const [transcript, projects] = await Promise.all([
      paired.call("threads.transcript", { threadId: thread.id }),
      paired.call("projects.list", undefined),
    ])
    expect(result(transcript).messages).toHaveLength(1)
    expect(result(projects)).toBeInstanceOf(Array)
    paired.socket.close()
  })

  test("a keyed mutation retried from a second socket runs once and answers the same result", async () => {
    const token = result(await invoke("remote.pairing", undefined)).token
    const project = result(await invoke("projects.list", undefined))[0] ?? (await createProject("remote-keyed"))
    const before = result(await invoke("threads.list", undefined)).length

    const first = phone(port)
    await first.send({ type: "auth", token })
    await first.ready()
    const created = await first.call("threads.create", { projectId: project.id }, "action-1")
    first.socket.terminate()

    const second = phone(port)
    await second.send({ type: "auth", token })
    await second.ready()
    const retried = await Promise.all([
      second.call("threads.create", { projectId: project.id }, "action-1"),
      second.call("threads.create", { projectId: project.id }, "action-1"),
    ])
    expect(retried).toStrictEqual([created, created])
    const concurrent = await Promise.all([
      second.call("threads.create", { projectId: project.id }, "action-2"),
      second.call("threads.create", { projectId: project.id }, "action-2"),
    ])
    expect(concurrent[1]).toStrictEqual(concurrent[0])
    expect(result(concurrent[0]).id).not.toBe(result(created).id)

    expect(result(await invoke("threads.list", undefined)).length).toBe(before + 2)
    second.socket.close()
  })

  test("a phone does not receive the VNC bytes and folder changes only the desktop window asked for", async () => {
    const paired = phone(port)
    await paired.send({ type: "auth", token: result(await invoke("remote.pairing", undefined)).token })
    await paired.ready()

    await runtime.runPromise(
      Events.use((events) =>
        Effect.all([
          events.publish({ type: "vm.screen.data", streamId: "s1", data: new Uint8Array([1, 2, 3]) }),
          events.publish({ type: "vm.screen.closed", streamId: "s1" }),
          events.publish({ type: "fs.changed", root: repo, path: "a.txt" }),
          events.publish({ type: "thread.removed", id: "marker" }),
        ]),
      ),
    )
    await paired.event((event) => event.type === "thread.removed" && event.id === "marker")
    const types = paired.frames.flatMap((frame) => (frame.type === "event" ? [(frame.event as PushEvent).type] : []))
    expect(types).not.toContain("vm.screen.data")
    expect(types).not.toContain("vm.screen.closed")
    expect(types).not.toContain("fs.changed")
    paired.socket.close()
  })

  test.each(["token", "proof"])("compacts live events only for a client requesting it with %s auth", async (auth) => {
    const { token } = result(await invoke("remote.pairing", undefined))
    const compact = phone(port)
    const full = phone(port)
    const explicitlyFull = phone(port)
    try {
      if (auth === "proof") {
        const challenge = await compact.challenge()
        const nonce = newNonce()
        await compact.send(
          JSON.stringify({
            type: "auth",
            nonce,
            proof: clientProof(token, challenge.nonce, nonce),
            compactEvents: true,
          }),
        )
      } else await compact.send(JSON.stringify({ type: "auth", token, compactEvents: true }))
      await full.send({ type: "auth", token })
      await explicitlyFull.send(JSON.stringify({ type: "auth", token, compactEvents: false }))
      await Promise.all([compact.ready(), full.ready(), explicitlyFull.ready()])

      const message: Message = {
        id: "compact-live-message",
        threadId: "compact-live-thread",
        role: "assistant",
        parts: [
          { type: "text", text: "Edited the file." },
          {
            type: "tool_call",
            callId: "write",
            name: "Write",
            input: { file_path: "a.ts", content: "large input" },
            output: "large output",
            status: "done",
          },
          {
            type: "tool_call",
            callId: "child",
            parentCallId: "agent",
            name: "Read",
            input: { file_path: "b.ts" },
            output: "child output",
            status: "done",
          },
          { type: "file_change", path: "a.ts", diff: "large diff" },
        ],
        createdAt: "2026-10-29T00:00:00.000Z",
        completedAt: null,
        usage: null,
        forkPoint: null,
      }
      const pushes: ReadonlyArray<PushEvent> = [
        { type: "message.created", seq: 1, message },
        { type: "message.updated", seq: 2, message: { ...message, completedAt: "2026-10-29T00:00:01.000Z" } },
        {
          type: "thread.event",
          threadId: message.threadId,
          seq: 3,
          event: {
            type: "tool_call_started",
            callId: "write",
            name: "Write",
            input: { file_path: "a.ts", content: "large input" },
          },
        },
        {
          type: "thread.event",
          threadId: message.threadId,
          seq: 4,
          event: { type: "tool_call_finished", callId: "write", output: "large output", isError: true },
        },
        {
          type: "thread.event",
          threadId: message.threadId,
          seq: 5,
          event: { type: "file_changed", path: "a.ts", diff: "large diff" },
        },
        { type: "thread.event", threadId: message.threadId, seq: 6, event: { type: "text_delta", text: "Done." } },
        { type: "thread.subagents", threadId: message.threadId, subagents: [subagent] },
        { type: "thread.removed", id: "compact-live-marker" },
      ]
      await runtime.runPromise(Events.use((events) => Effect.forEach(pushes, events.publish, { discard: true })))
      await Promise.all(
        [compact, full, explicitlyFull].map((client) =>
          client.event((event) => event.type === "thread.removed" && event.id === "compact-live-marker"),
        ),
      )
      const received = (client: ReturnType<typeof phone>) =>
        client.frames.flatMap((frame) => (frame.type === "event" ? [frame.event] : []))
      expect(received(full)).toEqual(pushes)
      expect(received(explicitlyFull)).toEqual(pushes)
      const compactMessage = {
        ...message,
        parts: [
          { type: "text", text: "Edited the file." },
          { type: "tool_call", callId: "write", name: "Write", input: { file_path: "a.ts" }, status: "done" },
          { type: "file_change", path: "a.ts", diff: "" },
        ],
      }
      expect(received(compact)).toEqual([
        { type: "message.created", seq: 1, message: compactMessage },
        { type: "message.updated", seq: 2, message: { ...compactMessage, completedAt: "2026-10-29T00:00:01.000Z" } },
        {
          type: "thread.event",
          threadId: message.threadId,
          seq: 3,
          event: { type: "tool_call_started", callId: "write", name: "Write", input: { file_path: "a.ts" } },
        },
        {
          type: "thread.event",
          threadId: message.threadId,
          seq: 4,
          event: { type: "tool_call_finished", callId: "write", output: "", isError: true },
        },
        {
          type: "thread.event",
          threadId: message.threadId,
          seq: 5,
          event: { type: "file_changed", path: "a.ts", diff: "" },
        },
        ...pushes.slice(5),
      ])
      expect(electron.pushes.slice(-pushes.length).map((push) => push.payload)).toEqual(pushes)
    } finally {
      for (const client of [compact, full, explicitlyFull]) client.socket.close()
    }
  })

  test("rotating the token disconnects every phone and the old token stops working", async () => {
    const before = result(await invoke("remote.pairing", undefined))
    const paired = phone(port)
    await paired.send({ type: "auth", token: before.token })
    await paired.ready()

    const after = result(await invoke("remote.rotateToken", undefined))
    expect(after.token).not.toBe(before.token)
    expect((await paired.closed()).code).toBe(RemoteAccess.CLOSE_TOKEN_ROTATED)

    const stale = phone(port)
    await stale.send({ type: "auth", token: before.token })
    expect((await stale.closed()).code).toBe(RemoteAccess.CLOSE_UNAUTHORIZED)
  })

  test("turning remote off closes a socket that has not authenticated yet", async () => {
    const pending = phone(port)
    await pending.opened
    result(await invoke("settings.set", { remote: { enabled: false, bindHost: "127.0.0.1", port } }))
    await vi.waitFor(async () => expect(result(await invoke("remote.status", undefined)).listening).toBe(false))
    await pending.send({ type: "auth", token: result(await invoke("remote.pairing", undefined)).token })
    expect((await pending.closed()).code).toBe(RemoteAccess.CLOSE_LISTENER_STOPPED)

    result(await invoke("settings.set", { remote: { enabled: true, bindHost: "127.0.0.1", port } }))
    await vi.waitFor(async () => expect(result(await invoke("remote.status", undefined)).listening).toBe(true))
  })

  test("a port already in use is reported as a listen error", async () => {
    const occupied = createServer()
    await new Promise<void>((resolve) => occupied.listen(0, "127.0.0.1", resolve))
    const busyPort = (occupied.address() as AddressInfo).port
    try {
      result(await invoke("settings.set", { remote: { enabled: true, bindHost: "127.0.0.1", port: busyPort } }))
      await vi.waitFor(async () =>
        expect(result(await invoke("remote.status", undefined)).listenError).toMatch(/EADDRINUSE/),
      )
      expect(result(await invoke("remote.status", undefined)).listening).toBe(false)
    } finally {
      occupied.close()
      result(await invoke("settings.set", { remote: { enabled: true, bindHost: "127.0.0.1", port } }))
      await vi.waitFor(async () => expect(result(await invoke("remote.status", undefined)).listening).toBe(true))
    }
  })

  test("turning remote off releases the port and turning it back on listens again", async () => {
    result(await invoke("settings.set", { remote: { enabled: false, bindHost: "127.0.0.1", port } }))
    await vi.waitFor(async () => expect(result(await invoke("remote.status", undefined)).listening).toBe(false))
    const refused = await new Promise<string>((resolve) => {
      const probe = createConnection({ host: "127.0.0.1", port })
      probe.once("error", (error: NodeJS.ErrnoException) => resolve(error.code ?? "error"))
      probe.once("connect", () => {
        probe.destroy()
        resolve("connected")
      })
    })
    expect(refused).toBe("ECONNREFUSED")

    result(await invoke("settings.set", { remote: { enabled: true, bindHost: "127.0.0.1", port } }))
    await vi.waitFor(async () => expect(result(await invoke("remote.status", undefined)).listening).toBe(true))
    const back = phone(port)
    await back.send({ type: "auth", token: result(await invoke("remote.pairing", undefined)).token })
    await back.ready()
    back.socket.close()
  })
})

describe("remote mode under a test clock", () => {
  let port = 0
  let clocked: ManagedRuntime.ManagedRuntime<Layer.Success<ReturnType<typeof makeLayer>> | TestClock.TestClock, unknown>
  const adjust = (duration: Duration.Input) => clocked.runPromise(TestClock.adjust(duration))
  const pairedPhone = async (options?: { autoPong: boolean }) => {
    const paired = phone(port, options)
    await paired.send({
      type: "auth",
      token: (await clocked.runPromise(RemoteAccess.RemoteAccess.use((access) => access.pairing))).token,
    })
    await paired.ready()
    return paired
  }

  beforeAll(async () => {
    port = await unusedLoopbackPort()
    clocked = ManagedRuntime.make(
      makeLayer(join(dir, "clocked.sqlite")).pipe(Layer.provideMerge(TestClock.layer())),
    ) as typeof clocked
    await clocked.runPromise(
      Settings.Settings.use((settings) => settings.set({ remote: { enabled: true, bindHost: "127.0.0.1", port } })),
    )
    await vi.waitFor(async () =>
      expect((await clocked.runPromise(RemoteAccess.RemoteAccess.use((access) => access.status))).listening).toBe(true),
    )
  })

  afterAll(() => clocked.dispose())

  test("a socket that does not authenticate in time is closed as an auth timeout", async () => {
    const pending = phone(port)
    await pending.opened
    await adjust("5 seconds")
    expect((await pending.closed()).code).toBe(RemoteAccess.CLOSE_AUTH_TIMEOUT)
  })

  const createThread = async (key: string) => {
    const paired = await pairedPhone()
    const projects = result(await paired.call("projects.list", undefined))
    const project =
      projects[0] ??
      result(await paired.call("projects.create", { name: "clocked", rootPath: repo, setupScript: null }))
    const created = result(await paired.call("threads.create", { projectId: project.id }, key))
    paired.socket.close()
    return created.id
  }

  test("a call key answers its stored result for five minutes after it settles, then runs again", async () => {
    const first = await createThread("ttl")
    await adjust("299 seconds")
    expect(await createThread("ttl")).toBe(first)
    await adjust("1 second")
    expect(await createThread("ttl")).not.toBe(first)
  })

  test("a full cache still answers a stored key and evicts the oldest settled key only for a new one", async () => {
    await adjust("5 minutes")
    const oldest = await createThread("oldest")

    const invalidPayload = {}
    const filler = await pairedPhone()
    for (let id = 1; id < MAX_CALL_KEYS; id++) {
      await filler.send({ type: "call", id, method: "threads.create", payload: invalidPayload, key: `filler-${id}` })
    }
    await filler.answered(MAX_CALL_KEYS - 1)
    filler.socket.close()

    expect(await createThread("oldest")).toBe(oldest)
    await createThread("newest")
    expect(await createThread("oldest")).not.toBe(oldest)
  })

  test("the heartbeat terminates a socket that stops answering pings and keeps one that answers", async () => {
    const live = await pairedPhone()
    const dead = await pairedPhone({ autoPong: false })

    await adjust("20 seconds")
    await Promise.all([live.pinged, dead.pinged])
    await live.send({ type: "ping", at: 1 })
    await live.pong(1)

    await adjust("20 seconds")
    expect((await dead.closed()).code).toBe(1006)
    await live.send({ type: "ping", at: 2 })
    await live.pong(2)
    expect(live.socket.readyState).toBe(WebSocket.OPEN)
    live.socket.close()
  })
})
