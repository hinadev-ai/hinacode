import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, test } from "@effect/vitest"
import { vi } from "vitest"
import { NodeServices } from "@effect/platform-node"
import { Effect, Layer, ManagedRuntime } from "effect"
import { unlistedModel } from "../shared/agent.ts"
import { EVENT_CHANNEL, RPC_CHANNEL } from "../shared/channels.ts"
import type { PushEvent, RpcEnvelope, RpcMethod, RpcRequestEncoded, RpcResponseEncoded } from "../shared/contract.ts"
import type { Project, Thread, Worktree } from "../shared/domain.ts"
import * as Db from "./db/client.ts"
import { eventsLayer, registerIpc } from "./ipc.ts"
import * as Mcp from "./mcp/index.ts"
import { AgentRunner } from "./services/AgentRunner.ts"
import * as Attachments from "./services/Attachments.ts"
import { Automations } from "./services/automations/Automations.ts"
import * as Git from "./services/Git.ts"
import * as GitHub from "./services/GitHub.ts"
import * as Messages from "./services/Messages.ts"
import * as Ports from "./services/Ports.ts"
import * as Projects from "./services/Projects.ts"
import * as PullRequests from "./services/PullRequests.ts"
import * as Settings from "./services/Settings.ts"
import * as Threads from "./services/Threads.ts"
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
    fromWebContents: () => null,
  },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  shell: { showItemInFolder: () => undefined },
  safeStorage: { isEncryptionAvailable: () => false },
}))

const appUrl = "file:///opt/kkcode/out/renderer/index.html"
const mainFrame: Frame = { url: appUrl, parent: null }

// Agents and automations are not exercised here: their handlers only forward to these services.
const runnerStub: Partial<typeof AgentRunner.Service> = {
  listModels: (provider) => Effect.succeed([unlistedModel(`${provider}-model`, provider)]),
}
const agentStubs = Layer.mergeAll(
  Layer.succeed(AgentRunner, runnerStub as typeof AgentRunner.Service),
  Layer.succeed(Automations, {} as typeof Automations.Service),
)

/** The production composition from `index.ts`, with the agent layers replaced by stubs. */
const makeLayer = (dbPath: string) => {
  const domain = Layer.mergeAll(
    Threads.layer.pipe(Layer.provideMerge(Worktrees.layer), Layer.provideMerge(Projects.layer)),
    Settings.layer,
    Messages.layer,
    Attachments.layer,
  )
  const features = Layer.mergeAll(Mcp.layer, Ports.layer).pipe(Layer.provide(domain))
  return Layer.mergeAll(domain, features, agentStubs).pipe(
    Layer.provide(Layer.mergeAll(Git.layer, eventsLayer)),
    Layer.provideMerge(GitHub.layer),
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

  test("settings written through rpc are what the next read returns", async () => {
    const saved = result(await invoke("settings.set", { locale: "zh-TW", keybindings: { "sidebar.toggle": "mod+k" } }))
    expect(saved).toMatchObject({ locale: "zh-TW", keybindings: { "sidebar.toggle": "mod+k" } })
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
})
