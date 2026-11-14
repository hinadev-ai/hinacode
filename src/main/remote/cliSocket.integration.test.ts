import { execFileSync } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { Effect, Layer, ManagedRuntime, Stream } from "effect"
import { afterAll, beforeAll, expect, test, vi } from "vitest"
import { WebSocket } from "ws"
import { unlistedModel } from "../../shared/agent.ts"
import type { PushEvent, RpcEnvelope, RpcMethod, RpcRequestEncoded, RpcResponseEncoded } from "../../shared/contract.ts"
import type { Thread } from "../../shared/domain.ts"
import { type ClientFrame, pairingUrl, type ServerFrame } from "../../shared/remote.ts"
import { ClaudeProvider } from "../agents/claude/index.ts"
import { CodexProvider } from "../agents/codex/index.ts"
import { MuseProvider } from "../agents/muse/index.ts"
import { OpencodeProvider } from "../agents/opencode/index.ts"
import { MagpieProvider } from "../agents/magpie/index.ts"
import type { AgentProvider } from "../agents/provider.ts"
import { dispatch } from "../rpc.ts"
import { Environments } from "../services/Environments.ts"
import { Events, makeEventsLayer } from "../services/Events.ts"
import { Settings } from "../services/Settings.ts"
import { makeTestAppLayer } from "../testing.ts"
import { CLOSE_MALFORMED_FRAME, RemoteAccess } from "./access.ts"
import { cliSocketPath } from "./cliSocketPath.ts"
import * as CliSocket from "./cliSocket.ts"
import { unusedLoopbackPort } from "./testing.ts"

vi.mock("electron", () => ({
  Notification: EventTarget,
  app: { getPath: () => "", focus: () => {} },
  ipcMain: { handle: () => {} },
  BrowserWindow: { getAllWindows: () => [], fromWebContents: () => null },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  shell: { showItemInFolder: () => undefined },
  safeStorage: { isEncryptionAvailable: () => false },
}))

const provider = (id: AgentProvider["id"]): AgentProvider => ({
  id,
  listModels: Effect.succeed([unlistedModel(`${id}-model`, id)]),
  account: () => Effect.succeed({ type: "signedOut" }),
  planLimits: () => Effect.succeed(null),
  usage: () => Effect.succeed(null),
  listCommands: () => Effect.succeed([]),
  runTurn: () => Stream.empty,
  steer: () => Effect.succeed(true),
  interrupt: () => Effect.void,
  respondApproval: () => Effect.succeed(false),
  respondQuestion: () => Effect.void,
  setAccessMode: () => Effect.void,
})

const providers = Layer.mergeAll(
  Layer.succeed(ClaudeProvider, provider("claude")),
  Layer.succeed(CodexProvider, provider("codex")),
  Layer.succeed(MuseProvider, provider("muse")),
  Layer.succeed(OpencodeProvider, provider("opencode")),
  Layer.succeed(MagpieProvider, provider("magpie")),
)

const makeDesktop = (dataDir: string) => {
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

const cli = (socketPath: string) => {
  const socket = new WebSocket(`ws+unix://${socketPath}:/remote`)
  const frames: Array<ServerFrame> = []
  const watchers = new Set<() => void>()
  let closed: number | null = null
  const notify = () => {
    for (const check of watchers) check()
  }
  socket.on("message", (raw) => {
    frames.push(JSON.parse(String(raw)) as ServerFrame)
    notify()
  })
  socket.on("close", (code) => {
    closed = code
    notify()
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
    frames,
    socket,
    send: async (frame: ClientFrame) => {
      await opened
      socket.send(JSON.stringify(frame))
    },
    call: async <M extends RpcMethod>(method: M, payload: RpcRequestEncoded<M>) => {
      const id = nextId++
      await opened
      socket.send(JSON.stringify({ type: "call", id, method, payload } satisfies ClientFrame))
      const frame = await until(() => frames.find((f) => f.type === "result" && f.id === id))
      return (frame as Extract<ServerFrame, { type: "result" }>).envelope as RpcEnvelope<RpcResponseEncoded<M>>
    },
    ready: () => until(() => frames.find((f) => f.type === "ready")),
    event: (predicate: (event: typeof PushEvent.Encoded) => boolean) =>
      until(() => frames.find((f) => f.type === "event" && predicate(f.event))),
    closed: () => until(() => closed ?? undefined),
  }
}

const gitRepo = (path: string) => {
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
    "i",
  ])
}

let dir = ""
let cloud: ManagedRuntime.ManagedRuntime<Layer.Success<ReturnType<typeof makeTestAppLayer>>, unknown>
let desktop: ReturnType<typeof makeDesktop>
let socketPath = ""
let cloudThread = ""

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "kk-cli-socket-test-"))
  mkdirSync(join(dir, "cloud"), { mode: 0o700 })
  mkdirSync(join(dir, "desktop"), { mode: 0o700 })
  gitRepo(join(dir, "cloud-repo"))
  socketPath = cliSocketPath(join(dir, "desktop"))

  const cloudPort = await unusedLoopbackPort()
  cloud = ManagedRuntime.make(makeTestAppLayer(join(dir, "cloud", "hinacode.sqlite"), { providers }))
  await cloud.runPromise(
    Settings.use((settings) => settings.set({ remote: { enabled: true, bindHost: "127.0.0.1", port: cloudPort } })),
  )
  await vi.waitFor(async () =>
    expect((await cloud.runPromise(RemoteAccess.use((remote) => remote.status))).listening).toBe(true),
  )
  const project = result(
    await cloud.runPromise(
      dispatch(
        { method: "projects.create", payload: { name: "web", rootPath: join(dir, "cloud-repo"), setupScript: null } },
        null,
      ),
    ),
  ) as { id: string }
  cloudThread = (
    result(
      await cloud.runPromise(dispatch({ method: "threads.create", payload: { projectId: project.id } }, null)),
    ) as {
      id: string
    }
  ).id

  desktop = makeDesktop(join(dir, "desktop"))
  const { port, token } = await cloud.runPromise(RemoteAccess.use((remote) => remote.pairing))
  const url = pairingUrl({ hosts: ["127.0.0.1"], port, token, relay: null })
  await desktop.runPromise(Environments.use((environments) => environments.add({ name: "cloud", pairingUrl: url })))
  await vi.waitFor(async () =>
    expect((await desktop.runPromise(Environments.use((environments) => environments.list))).clouds).toMatchObject([
      { status: "connected" },
    ]),
  )
}, 60_000)

afterAll(async () => {
  await desktop.dispose()
  await cloud.dispose()
  rmSync(dir, { recursive: true, force: true })
})

test("a client gets ready without auth, and lists threads from the desktop and its cloud", async () => {
  const client = cli(socketPath)
  const ready = await client.ready()
  expect(client.frames[0]).toBe(ready)
  expect(ready.features).not.toContain("asks")
  const threads = result(await client.call("threads.list", undefined)) as ReadonlyArray<Thread>
  expect(threads.map((thread) => thread.id)).toContain(cloudThread)
  client.socket.close()
})

test("a cloud event reaches the socket", async () => {
  const client = cli(socketPath)
  await client.ready()
  await cloud.runPromise(Events.use((events) => events.publish({ type: "thread.removed", id: "cloud-marker" })))
  expect(await client.event((event) => event.type === "thread.removed" && event.id === "cloud-marker")).toBeDefined()
  client.socket.close()
})

test("a sub-agent's calls never reach the compact socket", async () => {
  const client = cli(socketPath)
  await client.ready()
  const events = [
    { type: "tool_call_started", callId: "agent", name: "Agent", input: { description: "Explore" } },
    { type: "tool_call_started", callId: "read", name: "Read", input: { file_path: "a.ts" }, parentCallId: "agent" },
    { type: "tool_call_finished", callId: "read", output: "x", isError: false },
    { type: "tool_call_finished", callId: "agent", output: "found it", isError: false },
  ] as const
  for (const [seq, event] of events.entries())
    await desktop.runPromise(
      Events.use((bus) => bus.publish({ type: "thread.event", seq, threadId: "subagent-thread", event })),
    )
  await desktop.runPromise(Events.use((bus) => bus.publish({ type: "thread.removed", id: "subagent-marker" })))
  await client.event((event) => event.type === "thread.removed" && event.id === "subagent-marker")
  const callIds = client.frames.flatMap((frame) =>
    frame.type === "event" && frame.event.type === "thread.event" && "callId" in frame.event.event
      ? [frame.event.event.callId]
      : [],
  )
  expect(callIds).toStrictEqual(["agent", "agent"])
  client.socket.close()
})

test("revealing a cloud thread reaches the desktop's windows", async () => {
  const client = cli(socketPath)
  await client.ready()
  expect(await client.call("threads.reveal", { threadId: cloudThread })).not.toHaveProperty("error")
  expect(await client.event((event) => event.type === "thread.reveal" && event.threadId === cloudThread)).toBeDefined()
  client.socket.close()
})

test("desktop-only methods are refused, and auth frames close the socket", async () => {
  const client = cli(socketPath)
  expect(await client.call("environments.list", undefined)).toStrictEqual({
    error: { tag: "DesktopOnly", message: "environments.list is only available in the desktop window" },
  })
  await client.send({ type: "auth", token: "anything" })
  expect(await client.closed()).toBe(CLOSE_MALFORMED_FRAME)
})

test("the socket is private to the user", () => {
  expect(statSync(socketPath).mode & 0o777).toBe(0o600)
})

test("a data folder other users can open still gets a private socket, removed when it stops", async () => {
  const open = join(dir, "open")
  mkdirSync(open)
  chmodSync(open, 0o755)
  const runtime = makeDesktop(open)
  await runtime.runPromise(Effect.void)
  const client = cli(cliSocketPath(open))
  expect((await client.ready()).type).toBe("ready")
  client.socket.close()
  expect(statSync(dirname(cliSocketPath(open))).mode & 0o777).toBe(0o700)
  await runtime.dispose()
  expect(existsSync(cliSocketPath(open))).toBe(false)
})

test("a data folder too deep for a socket path still gets a reachable socket", async () => {
  const deep = join(dir, "a".repeat(60), "b".repeat(60))
  mkdirSync(deep, { recursive: true, mode: 0o700 })
  const runtime = makeDesktop(deep)
  await runtime.runPromise(Effect.void)
  const client = cli(cliSocketPath(deep))
  expect((await client.ready()).type).toBe("ready")
  client.socket.close()
  await runtime.dispose()
})
