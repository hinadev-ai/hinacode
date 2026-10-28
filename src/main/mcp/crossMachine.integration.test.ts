import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { Effect, Layer, ManagedRuntime, Schema, Stream } from "effect"
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest"
import { unlistedModel } from "../../shared/agent.ts"
import { RPC_CHANNEL } from "../../shared/channels.ts"
import {
  PushEvent,
  type RpcEnvelope,
  type RpcMethod,
  type RpcRequestEncoded,
  type RpcResponseEncoded,
} from "../../shared/contract.ts"
import { pairingUrl } from "../../shared/remote.ts"
import { ClaudeProvider } from "../agents/claude/index.ts"
import { CodexProvider } from "../agents/codex/index.ts"
import { MuseProvider } from "../agents/muse/index.ts"
import type { AgentProvider } from "../agents/provider.ts"
import { registerIpc } from "../ipc.ts"
import { RemoteAccess } from "../remote/access.ts"
import { unusedLoopbackPort } from "../remote/testing.ts"
import { Peers } from "../remote/peers.ts"
import { Events, PushBroadcast, WindowPush } from "../services/Events.ts"
import { Messages } from "../services/Messages.ts"
import { Settings } from "../services/Settings.ts"
import { makeTestAppLayer } from "../testing.ts"
import { McpCredentials } from "./credentials.ts"

type IpcHandler = (event: { sender: object; senderFrame: Frame }, raw: unknown) => Promise<unknown>
interface Frame {
  readonly url: string
  readonly parent: Frame | null
}

const electron = vi.hoisted(() => ({ handlers: new Map<string, IpcHandler>(), userData: "" }))

vi.mock("electron", () => ({
  Notification: EventTarget,
  app: { getPath: () => electron.userData, focus: () => {} },
  ipcMain: { handle: (channel: string, handler: IpcHandler) => electron.handlers.set(channel, handler) },
  BrowserWindow: { getAllWindows: () => [], fromWebContents: () => null },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  shell: { showItemInFolder: () => undefined },
  safeStorage: { isEncryptionAvailable: () => false },
}))

const appUrl = "file:///opt/hinacode/out/renderer/index.html"

const provider = (id: AgentProvider["id"]): AgentProvider => ({
  id,
  listModels: Effect.succeed([unlistedModel(`${id}-model`, id)]),
  account: () => Effect.succeed({ type: "signedOut" }),
  planLimits: () => Effect.succeed(null),
  usage: () => Effect.succeed(null),
  listCommands: () => Effect.succeed([]),
  runTurn: () => Stream.empty,
  steer: () => Effect.void,
  interrupt: () => Effect.void,
  respondApproval: () => Effect.void,
  respondQuestion: () => Effect.void,
  setAccessMode: () => Effect.void,
})

const providers = Layer.mergeAll(
  Layer.succeed(ClaudeProvider, provider("claude")),
  Layer.succeed(CodexProvider, provider("codex")),
  Layer.succeed(MuseProvider, provider("muse")),
)

/** A headless cloud has no windows: its pushes reach only the remote listener's sinks. */
const makeCloudEvents = () => {
  const sinks = new Set<(event: typeof PushEvent.Encoded) => void>()
  const encode = Schema.encodeSync(PushEvent)
  return Layer.mergeAll(
    Layer.succeed(
      Events,
      Events.of({
        publish: (event) =>
          Effect.sync(() => {
            for (const sink of sinks) sink(encode(event))
          }),
      }),
    ),
    Layer.succeed(WindowPush, WindowPush.of({ send: () => Effect.void })),
    Layer.succeed(
      PushBroadcast,
      PushBroadcast.of({
        subscribe: (sink) =>
          Effect.acquireRelease(
            Effect.sync(() => void sinks.add(sink)),
            () => Effect.sync(() => void sinks.delete(sink)),
          ),
      }),
    ),
  )
}

const makeCloud = (dbPath: string) => makeTestAppLayer(dbPath, { providers, events: makeCloudEvents() })
const makeDesktop = (dbPath: string) => makeTestAppLayer(dbPath, { providers })
type Runtime = ManagedRuntime.ManagedRuntime<Layer.Success<ReturnType<typeof makeDesktop>>, unknown>

let dir = ""
let cloud: Runtime
let desktop: Runtime

const invoke = <M extends RpcMethod>(method: M, payload: RpcRequestEncoded<M>, environment?: string) =>
  electron.handlers.get(RPC_CHANNEL)!(
    { sender: {}, senderFrame: { url: appUrl, parent: null } },
    { method, payload, environment },
  ) as Promise<RpcEnvelope<RpcResponseEncoded<M>>>

const result = <A>(envelope: RpcEnvelope<A>): A => {
  if ("error" in envelope) throw new Error(`${envelope.error.tag}: ${envelope.error.message}`)
  return envelope.result
}

const gitRepo = (path: string, origin: string) => {
  execFileSync("git", ["init", "-q", "-b", "main", path])
  execFileSync("git", [
    "-C",
    path,
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
  execFileSync("git", ["-C", path, "remote", "add", "origin", origin])
}

/** Calls one tool as `threadId`, through the MCP server of the machine the thread lives on. */
const callAs = async (runtime: Runtime, threadId: string, name: string, args: Record<string, unknown> = {}) => {
  const { url, headers } = await runtime.runPromise(
    McpCredentials.use((credentials) => credentials.connectionFor(threadId)),
  )
  const client = new Client({ name: "test", version: "0" })
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } }))
  try {
    const called = await client.callTool({ name, arguments: args })
    const content = called.content as Array<{ text?: string }>
    return { text: content.map((part) => part.text ?? "").join(""), isError: called.isError === true }
  } finally {
    await client.close()
  }
}

const seedMessage = (runtime: Runtime, threadId: string, text: string) =>
  runtime.runPromise(
    Messages.use((messages) =>
      messages.insert({
        id: `${threadId}-m1`,
        threadId,
        role: "user",
        parts: [{ type: "text", text }],
        createdAt: "2026-10-26T00:00:00.000Z",
        completedAt: "2026-10-26T00:00:00.000Z",
        usage: null,
      }),
    ),
  )

const onMachine = (machine: { id: string; name: string }) =>
  `machine: ${machine.name} (${machine.id}), not this one, so its paths are not here`

let cloudId = ""
let desktopMachine = { id: "", name: "" }
let desktopThread = ""
let cloudThread = ""
let otherRepoThread = ""

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "kk-cross-machine-test-"))
  electron.userData = dir
  const desktopRepo = join(dir, "desktop-repo")
  const otherRepo = join(dir, "other-repo")
  const cloudRepo = join(dir, "cloud-repo")
  gitRepo(desktopRepo, "git@github.com:Acme/Web.git")
  gitRepo(otherRepo, "git@github.com:Acme/Other.git")
  gitRepo(cloudRepo, "git@github.com:Acme/Web.git")
  mkdirSync(join(dir, "cloud"))
  mkdirSync(join(dir, "desktop"))

  const cloudPort = await unusedLoopbackPort()
  cloud = ManagedRuntime.make(makeCloud(join(dir, "cloud", "hinacode.sqlite")))
  await cloud.runPromise(
    Settings.use((settings) => settings.set({ remote: { enabled: true, bindHost: "127.0.0.1", port: cloudPort } })),
  )
  await vi.waitFor(async () =>
    expect((await cloud.runPromise(RemoteAccess.use((remote) => remote.status))).listening).toBe(true),
  )
  desktop = ManagedRuntime.make(makeDesktop(join(dir, "desktop", "hinacode.sqlite")))
  registerIpc(desktop, appUrl)
  desktopMachine = await desktop.runPromise(RemoteAccess.use((remote) => Effect.succeed(remote.identity)))

  const pairing = await cloud.runPromise(RemoteAccess.use((remote) => remote.pairing))
  const url = pairingUrl({ hosts: ["127.0.0.1"], port: pairing.port, token: pairing.token, relay: null })
  cloudId = result(await invoke("environments.add", { name: "cloud", pairingUrl: url })).id
  await vi.waitFor(async () =>
    expect(result(await invoke("environments.list", undefined)).clouds).toMatchObject([{ status: "connected" }]),
  )

  const web = result(await invoke("projects.create", { name: "web", rootPath: desktopRepo, setupScript: null }))
  const other = result(await invoke("projects.create", { name: "other", rootPath: otherRepo, setupScript: null }))
  const cloudWeb = result(
    await invoke("projects.create", { name: "web", rootPath: cloudRepo, setupScript: null }, cloudId),
  )
  desktopThread = result(await invoke("threads.create", { projectId: web.id })).id
  otherRepoThread = result(await invoke("threads.create", { projectId: other.id })).id
  cloudThread = result(await invoke("threads.create", { projectId: cloudWeb.id })).id
  await seedMessage(desktop, desktopThread, "hello from the desktop")
  await seedMessage(cloud, cloudThread, "hello from the cloud")

  // The desktop registers as the cloud's hub after the socket opens, so wait until an ask reaches it.
  await vi.waitFor(
    async () => {
      const threads = await cloud.runPromise(Peers.use((peers) => peers.ask("threads.list", undefined)))
      expect(threads.map((thread) => thread.id)).toContain(desktopThread)
    },
    { timeout: 10_000 },
  )
}, 60_000)

afterAll(async () => {
  await desktop.dispose()
  await cloud.dispose()
  rmSync(dir, { recursive: true, force: true })
})

describe("thread tools across machines", () => {
  test("a desktop thread reads a cloud thread of the same repository", async () => {
    const read = await callAs(desktop, desktopThread, "read_thread", { threadId: cloudThread })
    expect(read.isError).toBe(false)
    expect(read.text).toContain(`thread_id: ${cloudThread}`)
    expect(read.text).toContain(onMachine({ id: cloudId, name: "cloud" }))
    expect(read.text).toContain("hello from the cloud")
  })

  test("a cloud thread reads a desktop thread of the same repository through the hub", async () => {
    const read = await callAs(cloud, cloudThread, "read_thread", { threadId: desktopThread })
    expect(read.isError).toBe(false)
    expect(read.text).toContain(`thread_id: ${desktopThread}`)
    expect(read.text).toContain(onMachine(desktopMachine))
    expect(read.text).toContain("hello from the desktop")
  })

  test("a cloud thread lists the desktop's threads of the same repository and itself once", async () => {
    const listed = await callAs(cloud, cloudThread, "list_threads")
    expect(listed.isError).toBe(false)
    const threads = JSON.parse(listed.text) as Array<{ id: string; self?: true; machine?: unknown }>
    expect(threads.toSorted((a, b) => a.id.localeCompare(b.id))).toMatchObject(
      [
        { id: cloudThread, self: true },
        { id: desktopThread, machine: desktopMachine },
      ].toSorted((a, b) => a.id.localeCompare(b.id)),
    )
    expect(threads).toHaveLength(2)
    expect(threads.find((thread) => thread.id === cloudThread)).not.toHaveProperty("machine")
  })

  test("a cloud thread cannot read a desktop thread of another repository", async () => {
    const read = await callAs(cloud, cloudThread, "read_thread", { threadId: otherRepoThread })
    expect(read).toStrictEqual({ isError: true, text: `Thread ${otherRepoThread} no longer exists.` })
  })

  test("a cloud thread sends to a desktop thread through the hub, with a model and effort", async () => {
    const sent = await callAs(cloud, cloudThread, "send_to_thread", {
      threadId: desktopThread,
      prompt: "hi from the cloud",
      model: "claude-other",
      effort: "high",
    })
    expect(sent).toStrictEqual({ isError: false, text: `Started a new turn on thread ${desktopThread}.` })
    const transcript = result(await invoke("threads.transcript", { threadId: desktopThread }))
    expect(JSON.stringify(transcript.messages)).toContain("hi from the cloud")
    const threads = result(await invoke("threads.list", undefined))
    expect(threads.find((thread) => thread.id === desktopThread)).toMatchObject({
      model: "claude-other",
      effort: "high",
    })
  })

  test("a desktop thread sends to a cloud thread, and stops it", async () => {
    const sent = await callAs(desktop, desktopThread, "send_to_thread", {
      threadId: cloudThread,
      prompt: "hi from the desktop",
    })
    expect(sent).toStrictEqual({ isError: false, text: `Started a new turn on thread ${cloudThread}.` })
    const transcript = result(await invoke("threads.transcript", { threadId: cloudThread }))
    expect(JSON.stringify(transcript.messages)).toContain("hi from the desktop")
    const stopped = await callAs(desktop, desktopThread, "stop_thread", { threadId: cloudThread })
    expect(stopped).toStrictEqual({ isError: false, text: `Interrupted thread ${cloudThread}.` })
  })

  test("a cloud thread cannot send to a desktop thread of another repository", async () => {
    const sent = await callAs(cloud, cloudThread, "send_to_thread", { threadId: otherRepoThread, prompt: "hi" })
    expect(sent).toStrictEqual({ isError: true, text: `Thread ${otherRepoThread} no longer exists.` })
  })

  test("a cloud with no desktop connected says so instead of calling the thread gone", async () => {
    result(await invoke("environments.remove", { id: cloudId }))
    await vi.waitFor(async () => {
      const read = await callAs(cloud, cloudThread, "read_thread", { threadId: desktopThread })
      expect(read).toStrictEqual({
        isError: true,
        text: `Thread ${desktopThread} is not on this machine, and the other machines are out of reach: This machine is not connected to any other HinaCode machine.`,
      })
    })
  })
})
