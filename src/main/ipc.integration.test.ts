import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, test } from "@effect/vitest"
import { vi } from "vitest"
import { NodeServices } from "@effect/platform-node"
import { Effect, Layer, ManagedRuntime, Stream } from "effect"
import { TestClock } from "effect/testing"
import type { AgentEvent, Subagent } from "../shared/agent.ts"
import { unlistedModel } from "../shared/agent.ts"
import { EVENT_CHANNEL, RPC_CHANNEL } from "../shared/channels.ts"
import type { PushEvent, RpcEnvelope, RpcMethod, RpcRequestEncoded, RpcResponseEncoded } from "../shared/contract.ts"
import type { Project, Thread, Worktree } from "../shared/domain.ts"
import { ClaudeProvider } from "./agents/claude/index.ts"
import { CodexProvider } from "./agents/codex/index.ts"
import type { AgentProvider } from "./agents/provider.ts"
import * as Db from "./db/client.ts"
import { eventsLayer, registerIpc } from "./ipc.ts"
import * as Mcp from "./mcp/index.ts"
import * as AgentRunner from "./services/AgentRunner.ts"
import * as Attachments from "./services/Attachments.ts"
import * as Files from "./services/Files.ts"
import { Automations } from "./services/automations/Automations.ts"
import * as Favicons from "./services/Favicons.ts"
import * as Git from "./services/Git.ts"
import * as GitHub from "./services/GitHub.ts"
import * as Messages from "./services/Messages.ts"
import * as Ports from "./services/Ports.ts"
import * as Terminals from "./services/Terminals.ts"
import * as Projects from "./services/Projects.ts"
import * as PullRequests from "./services/PullRequests.ts"
import * as Settings from "./services/Settings.ts"
import * as Threads from "./services/Threads.ts"
import { ThreadNaming } from "./services/ThreadNaming.ts"
import * as Worktrees from "./services/Worktrees.ts"

type IpcHandler = (event: { sender: object; senderFrame: Frame }, raw: unknown) => Promise<unknown>
interface Frame {
  readonly url: string
  readonly parent: Frame | null
}

/** The Electron surface `ipc.ts` and the services touch, recording what main would send to windows. */
const electron = vi.hoisted(() => ({
  handlers: new Map<string, IpcHandler>(),
  pushes: [] as Array<{ channel: string; payload: unknown }>,
  /** Called after every push, so a test can wait for the one it expects instead of polling. */
  watchers: new Set<() => void>(),
  shown: [] as Array<object>,
  userData: "",
}))

vi.mock("electron", () => ({
  app: { getPath: () => electron.userData },
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
      show: () => {
        electron.shown.push(sender)
      },
    }),
  },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  shell: { showItemInFolder: () => undefined },
  safeStorage: { isEncryptionAvailable: () => false },
}))

const appUrl = "file:///opt/kkcode/out/renderer/index.html"
const mainFrame: Frame = { url: appUrl, parent: null }

const subagent: Subagent = {
  id: "task-1",
  label: "Count repo files",
  kind: "general-purpose",
  status: "running",
  summary: null,
  lastTool: null,
  toolUses: 0,
  tokens: 0,
  startedAt: "2026-10-12T10:00:00.000Z",
  endedAt: null,
}

/** What the scripted provider answers every turn with: a sub-agent that runs and completes. */
const scriptedTurn: ReadonlyArray<AgentEvent> = [
  { type: "subagent_updated", subagent },
  { type: "text_delta", text: "Spawned one sub-agent." },
  {
    type: "subagent_updated",
    subagent: { ...subagent, status: "completed", summary: "218 files", lastTool: "Bash", toolUses: 1, tokens: 14310 },
  },
  { type: "turn_completed" },
]

const scriptedProvider = (id: AgentProvider["id"]): AgentProvider => ({
  id,
  listModels: Effect.succeed([unlistedModel(`${id}-model`, id)]),
  listCommands: () => Effect.succeed([]),
  runTurn: (input) =>
    Stream.fromIterable(
      input.prompt === "simulate usage limit"
        ? [
            {
              type: "turn_limited",
              limit: {
                kind: "usage",
                message: "Usage limit reached",
                reset: { at: new Date(Date.now() + 60000).toISOString(), autoResume: false },
              },
            },
          ]
        : scriptedTurn,
    ),
  steer: () => Effect.void,
  interrupt: () => Effect.void,
  respondApproval: () => Effect.void,
  setAccessMode: () => Effect.void,
})

const providers = Layer.mergeAll(
  Layer.succeed(ClaudeProvider, scriptedProvider("claude")),
  Layer.succeed(CodexProvider, scriptedProvider("codex")),
)

// Automations are not exercised here: their handlers only forward to the service.
const automationsStub = Layer.succeed(Automations, {} as typeof Automations.Service)

/** The production composition from `index.ts`, with scripted agent providers and a stubbed Automations. */
const makeLayer = (dbPath: string) => {
  const domain = Layer.mergeAll(
    Threads.layer.pipe(
      Layer.provideMerge(Worktrees.layer),
      Layer.provideMerge(Projects.layer),
      Layer.provideMerge(Settings.layer),
    ),
    Messages.layer,
    Attachments.layer,
    Files.layer,
  )
  const features = Layer.mergeAll(Mcp.credentialsLayer, Ports.layer, Terminals.layer).pipe(Layer.provide(domain))
  const agents = AgentRunner.layer.pipe(
    Layer.provide(Layer.mergeAll(providers, Layer.succeed(ThreadNaming, { nameFromPrompt: () => Effect.void }))),
    Layer.provideMerge(Layer.mergeAll(domain, features)),
  )
  const base = Layer.mergeAll(agents, automationsStub)
  return Layer.mergeAll(base, Mcp.serverLayer.pipe(Layer.provide(base))).pipe(
    Layer.provide(eventsLayer),
    Layer.provideMerge(Layer.mergeAll(Git.layer, GitHub.layer, Favicons.layer)),
    Layer.provide(Db.layer(dbPath)),
    Layer.provide(NodeServices.layer),
  )
}

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

/** Resolves as soon as a push matching `predicate` has been sent, including one sent already. */
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
  runtime = ManagedRuntime.make(makeLayer(join(dir, "kkcode.sqlite")))
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

  test("refuses calls from documents that are not the app and from subframes", async () => {
    const foreign = await invoke("settings.get", undefined, { url: "file:///tmp/probe.html", parent: null })
    expect(failure(foreign).tag).toBe("UntrustedSender")
    const subframe = await invoke("settings.get", undefined, { url: appUrl, parent: mainFrame })
    expect(failure(subframe).tag).toBe("UntrustedSender")
    expect("result" in (await invoke("settings.get", undefined))).toBe(true)
  })
})

describe("rpc contract", () => {
  test("answers an unknown method and a payload outside the contract with a schema error", async () => {
    const unknown = await invoke("no.such.method" as RpcMethod, undefined as never)
    expect(failure(unknown).tag).toBe("SchemaError")
    const payload = await invoke("threads.update", { id: "t", provider: "gpt" as "claude" })
    expect(failure(payload).tag).toBe("SchemaError")
  })

  test("surfaces a handler's tagged error with its message", async () => {
    const error = failure(
      await invoke("projects.create", {
        name: "nope",
        rootPath: join(dir, "missing"),
        setupScript: null,
      }),
    )
    expect(error.tag).toBe("ProjectRootInvalidError")
    expect(error.message).toContain("is not a directory")
  })
})

describe("projects, threads and settings over rpc", () => {
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
          pullRequests.link(first.id, "https://github.com/kjj6198/kkcode/pull/48"),
          pullRequests.link(first.id, "https://github.com/kjj6198/kkcode/pull/49"),
          pullRequests.link(second.id, "https://github.com/kjj6198/kkcode/pull/55"),
        ]),
      ),
    )
    const links = result(await invoke("pullRequests.all", undefined))
    expect(links.map((link) => [link.threadId, link.url])).toStrictEqual([
      [first.id, "https://github.com/kjj6198/kkcode/pull/48"],
      [first.id, "https://github.com/kjj6198/kkcode/pull/49"],
      [second.id, "https://github.com/kjj6198/kkcode/pull/55"],
    ])
  })

  test("a thread switches agent, back to that agent's defaults, only until its first message", async () => {
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
        }),
      ),
    )
    expect(failure(await invoke("threads.update", { id: thread.id, provider: "claude" })).tag).toBe(
      "ThreadStartedError",
    )
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

  test("reordering a thread keeps its updatedAt", async () => {
    const project = result(await invoke("projects.list", undefined))[0]!
    const created = result(await invoke("threads.create", { projectId: project.id }))
    // Last touched at the epoch, so a reorder that bumps updatedAt to the real clock cannot go unnoticed.
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
    expect(failure(await invoke("fs.read", { root: rootPath, path: "../kkcode.sqlite" })).tag).toBe("FsAccessError")
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
    const saved = result(await invoke("settings.set", { locale: "zh-TW", keybindings: { "sidebar.toggle": "mod+k" } }))
    expect(saved).toMatchObject({ locale: "zh-TW", keybindings: { "sidebar.toggle": "mod+k" } })
    expect(result(await invoke("settings.get", undefined))).toStrictEqual(saved)
  })

  test("notification preferences persist through the derived settings patch", async () => {
    const before = result(await invoke("settings.get", undefined))
    const notifications = { completed: false, needsInput: true, failed: false, sound: false }
    const saved = result(await invoke("settings.set", { notifications }))
    expect(saved).toStrictEqual({ ...before, notifications })
    expect(result(await invoke("settings.get", undefined))).toStrictEqual(saved)

    const malformed = await invoke("settings.set", { notifications: { ...notifications, sound: "yes" } } as never)
    expect(malformed).toMatchObject({ error: { tag: "SchemaError" } })
    expect(result(await invoke("settings.get", undefined))).toStrictEqual(saved)
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

    // Setup runs in the background; without a setup script it settles on `ready` almost at once.
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
})

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
