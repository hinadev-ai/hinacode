import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { type AddressInfo, createServer, type Socket } from "node:net"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, test } from "@effect/vitest"
import { vi } from "vitest"
import { Clock, type Duration, Effect, Layer, ManagedRuntime, Schema, Stream } from "effect"
import { TestClock } from "effect/testing"
import { WebSocket, WebSocketServer } from "ws"
import { SqlClient } from "effect/sql"
import { unlistedModel } from "../../shared/agent.ts"
import { EVENT_CHANNEL, RPC_CHANNEL } from "../../shared/channels.ts"
import {
  PushEvent,
  type RpcEnvelope,
  type RpcMethod,
  type RpcRequestEncoded,
  type RpcResponseEncoded,
} from "../../shared/contract.ts"
import {
  type ClientFrame,
  pairingUrl,
  REMOTE_PATH,
  REMOTE_PROTOCOL_VERSION,
  type ServerFrame,
} from "../../shared/remote.ts"
import { ClaudeProvider } from "../agents/claude/index.ts"
import { CodexProvider } from "../agents/codex/index.ts"
import { MuseProvider } from "../agents/muse/index.ts"
import type { AgentProvider } from "../agents/provider.ts"
import { registerIpc } from "../ipc.ts"
import { CLOSE_TOKEN_ROTATED, RemoteAccess } from "../remote/access.ts"
import { makeTestAppLayer } from "../testing.ts"
import { ClientSettings } from "./ClientSettings.ts"
import { Environments, type ForwardedCall } from "./Environments.ts"
import { Events, PushBroadcast, WindowPush } from "./Events.ts"
import { Secrets } from "./Secrets.ts"
import { Settings } from "./Settings.ts"
import { Threads } from "./Threads.ts"

type IpcHandler = (event: { sender: object; senderFrame: Frame }, raw: unknown) => Promise<unknown>
interface Frame {
  readonly url: string
  readonly parent: Frame | null
}

/** Only the desktop runtime has windows; what it sends them is recorded here. */
const electron = vi.hoisted(() => ({
  handlers: new Map<string, IpcHandler>(),
  pushes: [] as Array<PushEvent>,
  watchers: new Set<() => void>(),
  userData: "",
}))

vi.mock("electron", () => ({
  Notification: EventTarget,
  app: { getPath: () => electron.userData, focus: () => {} },
  ipcMain: { handle: (channel: string, handler: IpcHandler) => electron.handlers.set(channel, handler) },
  BrowserWindow: {
    getAllWindows: () => [
      {
        webContents: {
          send: (channel: string, payload: PushEvent) => {
            if (channel !== EVENT_CHANNEL) return
            electron.pushes.push(payload)
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

let dir = ""
let localRepo = ""
let cloudRepo = ""
let cloudPort = 0
let cloud: ManagedRuntime.ManagedRuntime<Layer.Success<ReturnType<typeof makeCloud>>, unknown>
let desktop: ManagedRuntime.ManagedRuntime<Layer.Success<ReturnType<typeof makeDesktop>>, unknown>
/** What a phone paired with the desktop would receive. */
const phonePushes: Array<typeof PushEvent.Encoded> = []

const invoke = <M extends RpcMethod>(method: M, payload: RpcRequestEncoded<M>, environment?: string) =>
  electron.handlers.get(RPC_CHANNEL)!(
    { sender: {}, senderFrame: { url: appUrl, parent: null } },
    { method, payload, environment },
  ) as Promise<RpcEnvelope<RpcResponseEncoded<M>>>

const result = <A>(envelope: RpcEnvelope<A>): A => {
  if ("error" in envelope) throw new Error(`${envelope.error.tag}: ${envelope.error.message}`)
  return envelope.result
}

const failure = (envelope: RpcEnvelope<unknown>) => {
  if ("result" in envelope) throw new Error(`expected an error, got ${JSON.stringify(envelope.result)}`)
  return envelope.error
}

/** Resolves as soon as the window got a push matching `predicate`, including one it got already. */
const pushedEventually = (predicate: (event: PushEvent) => boolean) =>
  new Promise<void>((resolve) => {
    const check = () => {
      if (!electron.pushes.some(predicate)) return
      electron.watchers.delete(check)
      resolve()
    }
    electron.watchers.add(check)
    check()
  })

const statusOf = (id: string, status: string) => (event: PushEvent) =>
  event.type === "environment.status" && event.id === id && event.status === status

const setCloudRemote = (enabled: boolean) =>
  cloud.runPromise(
    Settings.use((settings) => settings.set({ remote: { enabled, bindHost: "127.0.0.1", port: cloudPort } })),
  )

/** The second host is unroutable, so a pairing that waits for it hangs. */
const cloudPairing = async (options: { token?: string; hosts?: [string, ...Array<string>] } = {}) => {
  const pairing = await cloud.runPromise(RemoteAccess.use((remote) => remote.pairing))
  return pairingUrl({
    hosts: options.hosts ?? ["127.0.0.1", "192.0.2.1"],
    port: pairing.port,
    token: options.token ?? pairing.token,
  })
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
    "init",
  ])
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "kk-environments-test-"))
  electron.userData = dir
  localRepo = join(dir, "local-repo")
  cloudRepo = join(dir, "cloud-repo")
  gitRepo(localRepo)
  gitRepo(cloudRepo)
  execFileSync("git", ["-C", cloudRepo, "remote", "add", "origin", "git@github.com:Acme/Web.git"])
  mkdirSync(join(dir, "cloud"))
  mkdirSync(join(dir, "desktop"))
  cloudPort = 40000 + Math.floor(Math.random() * 20000)
  cloud = ManagedRuntime.make(makeCloud(join(dir, "cloud", "hinacode.sqlite")))
  await setCloudRemote(true)
  await vi.waitFor(async () =>
    expect((await cloud.runPromise(RemoteAccess.use((remote) => remote.status))).listening).toBe(true),
  )
  desktop = ManagedRuntime.make(makeDesktop(join(dir, "desktop", "hinacode.sqlite")))
  desktop.runFork(
    Effect.gen(function* () {
      const broadcast = yield* PushBroadcast
      yield* broadcast.subscribe((event) => phonePushes.push(event))
      yield* Effect.never
    }).pipe(Effect.scoped),
  )
  registerIpc(desktop, appUrl)
})

afterAll(async () => {
  await desktop.dispose()
  await cloud.dispose()
  rmSync(dir, { recursive: true, force: true })
})

describe("desktop environments", () => {
  let cloudId = ""
  let localThread = ""
  let cloudThread = ""

  test("refuses a URL that is not a pairing URL and a token the cloud does not accept", async () => {
    expect(failure(await invoke("environments.add", { name: "home", pairingUrl: "https://example.com" })).tag).toBe(
      "InvalidPairingUrl",
    )
    const wrong = await invoke("environments.add", {
      name: "home",
      pairingUrl: await cloudPairing({ token: "not-the-token", hosts: ["127.0.0.1"] }),
    })
    expect(failure(wrong)).toMatchObject({ tag: "EnvironmentUnauthorized" })
    expect(result(await invoke("environments.list", undefined)).clouds).toStrictEqual([])
  })

  test("pairs a cloud under its own id, keeps the token out of the row, and pairing again keeps one row", async () => {
    const identity = await cloud.runPromise(RemoteAccess.use((remote) => Effect.succeed(remote.identity)))
    const pairing = await cloud.runPromise(RemoteAccess.use((remote) => remote.pairing))
    const added = result(await invoke("environments.add", { name: "home-server", pairingUrl: await cloudPairing() }))
    expect(added).toMatchObject({ id: identity.id, name: "home-server", host: "127.0.0.1", port: cloudPort })
    cloudId = added.id
    await pushedEventually(statusOf(cloudId, "connected"))

    const again = result(await invoke("environments.add", { name: "", pairingUrl: await cloudPairing() }))
    expect(again).toMatchObject({ id: cloudId, name: "home-server" })

    const rows = await desktop.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => sql`SELECT * FROM environment`))
    expect(rows).toHaveLength(1)
    expect(JSON.stringify(rows)).not.toContain(pairing.token)
    expect(await desktop.runPromise(Secrets.use((secrets) => secrets.has(`environment.${cloudId}.token`)))).toBe(true)
    await vi.waitFor(async () =>
      expect(result(await invoke("environments.list", undefined)).clouds).toMatchObject([
        { id: cloudId, status: "connected", lastSeenAt: expect.any(String) },
      ]),
    )
  })

  test("lists merge this desktop and the cloud, and new projects go where the call names", async () => {
    const local = result(await invoke("projects.create", { name: "here", rootPath: localRepo, setupScript: null }))
    const remote = result(
      await invoke("projects.create", { name: "there", rootPath: cloudRepo, setupScript: null }, cloudId),
    )
    expect(local.environmentId).toBeUndefined()
    expect(remote.environmentId).toBe(cloudId)

    localThread = result(await invoke("threads.create", { projectId: local.id })).id
    cloudThread = result(await invoke("threads.create", { projectId: remote.id })).id
    const onCloud = await cloud.runPromise(Threads.use((threads) => threads.list))
    expect(onCloud.map((thread) => thread.id)).toStrictEqual([cloudThread])

    const projects = result(await invoke("projects.list", undefined))
    expect(projects.map((project) => [project.name, project.environmentId, project.repository])).toStrictEqual([
      ["here", undefined, undefined],
      ["there", cloudId, "acme/web"],
    ])
    const threads = result(await invoke("threads.list", undefined)).map((thread) => thread.id)
    expect(threads.toSorted()).toStrictEqual([localThread, cloudThread].toSorted())
  })

  test("a call on a thread goes to the environment that owns it", async () => {
    result(await invoke("threads.update", { id: cloudThread, title: "renamed on the cloud" }))
    result(await invoke("threads.update", { id: localThread, title: "renamed here" }))
    const [onCloud] = await cloud.runPromise(Threads.use((threads) => threads.list))
    expect(onCloud?.title).toBe("renamed on the cloud")
    const here = await desktop.runPromise(Threads.use((threads) => threads.list))
    expect(here.map((thread) => thread.title)).toStrictEqual(["renamed here"])
  })

  test("a file staged on a cloud thread travels as bytes, and the cloud reads back only staged files", async () => {
    const picked = join(dir, "picked.png")
    writeFileSync(picked, "png bytes")
    const staged = result(await invoke("attachments.stage", { threadId: cloudThread, source: { path: picked } }))
    expect(staged).toMatchObject({ name: "picked.png", mime: "image/png", kind: "image", bytes: 9 })

    const { dataUrl } = result(await invoke("attachments.read", { path: staged.path }, cloudId))
    expect(dataUrl).toBe(`data:image/png;base64,${Buffer.from("png bytes").toString("base64")}`)
    expect(failure(await invoke("attachments.read", { path: picked }, cloudId)).tag).toBe("AttachmentError")
  })

  test("the file viewer previews a cloud's files from the cloud, inside the root only", async () => {
    writeFileSync(join(cloudRepo, "page.html"), "<h1>cloud</h1>")
    const { dataUrl } = result(await invoke("fs.preview", { root: cloudRepo, path: "page.html" }))
    expect(dataUrl).toBe(`data:text/html;base64,${Buffer.from("<h1>cloud</h1>").toString("base64")}`)
    expect(failure(await invoke("fs.preview", { root: cloudRepo, path: "../picked.png" })).tag).toBe("FsAccessError")
  })

  test("the cloud's pushes reach the window and not the phones paired with this desktop", async () => {
    await pushedEventually(
      (event) =>
        event.type === "thread.updated" &&
        event.thread.id === cloudThread &&
        event.thread.title === "renamed on the cloud",
    )
    const phoneThreads = phonePushes.flatMap((event) => (event.type === "thread.updated" ? [event.thread.id] : []))
    expect(phoneThreads).toContain(localThread)
    expect(phoneThreads).not.toContain(cloudThread)
  })

  test("named calls read the named environment, and client settings stay on this desktop", async () => {
    await cloud.runPromise(Settings.use((settings) => settings.set({ textGenerationModel: "cloud-model" })))
    expect(result(await invoke("settings.get", undefined, cloudId)).textGenerationModel).toBe("cloud-model")
    expect(result(await invoke("settings.get", undefined)).textGenerationModel).not.toBe("cloud-model")
    expect(failure(await invoke("settings.get", undefined, "no-such-cloud")).tag).toBe("NotFoundError")

    result(await invoke("clientSettings.set", { locale: "ja" }))
    expect((await desktop.runPromise(ClientSettings.use((settings) => settings.get))).locale).toBe("ja")
    expect((await cloud.runPromise(ClientSettings.use((settings) => settings.get))).locale).toBe("en")
  })

  test("a stopped cloud keeps its last projects listed, and a call made meanwhile lands when it is back", async () => {
    await setCloudRemote(false)
    await pushedEventually(statusOf(cloudId, "offline"))
    const update = invoke("threads.update", { id: cloudThread, title: "sent while offline" })
    const projects = result(await invoke("projects.list", undefined))
    expect(projects.map((project) => project.name)).toStrictEqual(["here", "there"])
    result(await invoke("threads.update", { id: localThread, title: "still here" }))

    await setCloudRemote(true)
    expect(result(await update).title).toBe("sent while offline")
    const [onCloud] = await cloud.runPromise(Threads.use((threads) => threads.list))
    expect(onCloud?.title).toBe("sent while offline")
  })

  test("removing a cloud forgets it and its token", async () => {
    result(await invoke("environments.remove", { id: cloudId }))
    expect(result(await invoke("environments.list", undefined))).toStrictEqual({ clouds: [] })
    expect(await desktop.runPromise(Secrets.use((secrets) => secrets.has(`environment.${cloudId}.token`)))).toBe(false)
    expect(result(await invoke("projects.list", undefined)).map((project) => project.name)).toStrictEqual(["here"])
  })
})

interface ScriptedOptions {
  readonly features?: ReadonlyArray<string>
  readonly autoPong?: boolean
  readonly version?: number
  readonly host?: string
  readonly port?: number
}

const scriptedCloud = async (id: string, options: ScriptedOptions) => {
  let version = options.version ?? REMOTE_PROTOCOL_VERSION
  const server = new WebSocketServer({
    host: options.host ?? "127.0.0.1",
    port: options.port ?? 0,
    path: REMOTE_PATH,
    autoPong: options.autoPong ?? true,
  })
  const calls: Array<Extract<ClientFrame, { type: "call" }>> = []
  let current: WebSocket | undefined
  let holdReady = false
  let heldReady: ServerFrame | undefined
  server.on("connection", (socket) => {
    socket.on("message", (raw) => {
      const frame = JSON.parse(String(raw)) as ClientFrame
      if (frame.type === "call") calls.push(frame)
      if (frame.type !== "auth") return
      current = socket
      const ready: ServerFrame = {
        type: "ready",
        version,
        environment: { id, name: id },
        features: options.features ?? ["heartbeat", "call-keys", "some-future-feature"],
      }
      if (holdReady) heldReady = ready
      else socket.send(JSON.stringify(ready))
    })
  })
  await new Promise((resolve) => server.once("listening", resolve))
  const { port } = server.address() as AddressInfo
  return {
    port,
    pairingUrl: pairingUrl({ hosts: ["127.0.0.1"], port, token: "token" }),
    calls,
    holdReady: () => {
      holdReady = true
    },
    hasHeldReady: () => heldReady !== undefined,
    releaseReady: () => {
      current!.send(JSON.stringify(heldReady))
      heldReady = undefined
    },
    update: () => {
      version = REMOTE_PROTOCOL_VERSION
    },
    socket: () => current!,
    send: (frame: ServerFrame) => current!.send(JSON.stringify(frame)),
    stop: () => {
      server.close()
      for (const socket of server.clients) socket.terminate()
    },
  }
}

describe("desktop environments over a flaky link", () => {
  let clocked: ManagedRuntime.ManagedRuntime<Environments | TestClock.TestClock, unknown>

  const forward = (environmentId: string, call: ForwardedCall) =>
    clocked.runPromise(Environments.use((environments) => environments.forward(environmentId, call)))
  const adjust = (duration: Duration.Input) => clocked.runPromise(TestClock.adjust(duration))
  const testTime = () => clocked.runPromise(Clock.currentTimeMillis)

  const add = (url: string) =>
    clocked.runPromise(Environments.use((environments) => environments.add({ name: "", pairingUrl: url })))
  const pair = async (id: string, options: ScriptedOptions = {}) => {
    const scripted = await scriptedCloud(id, options)
    await add(scripted.pairingUrl)
    await pushedEventually(statusOf(id, "connected"))
    return scripted
  }
  const listed = async (id: string) =>
    (await clocked.runPromise(Environments.use((environments) => environments.list))).clouds.find(
      (entry) => entry.id === id,
    )
  const remove = (id: string) => clocked.runPromise(Environments.use((environments) => environments.remove(id)))

  const reconnectUntil = (done: () => void) =>
    vi.waitFor(async () => {
      await adjust("1 second")
      done()
    })

  beforeAll(() => {
    mkdirSync(join(dir, "clocked"))
    clocked = ManagedRuntime.make(
      makeDesktop(join(dir, "clocked", "hinacode.sqlite")).pipe(Layer.provideMerge(TestClock.layer())),
    )
  })

  afterAll(() => clocked.dispose())

  test("a mutation whose answer was lost is sent again once under the same key, ahead of calls made offline", async () => {
    const scripted = await pair("flaky")
    const update = forward("flaky", { method: "threads.update", payload: { id: "t1", title: "once" } })
    await vi.waitFor(() => expect(scripted.calls).toHaveLength(1))
    scripted.socket().terminate()
    await pushedEventually(statusOf("flaky", "offline"))
    const read = forward("flaky", { method: "settings.get", payload: undefined })

    await reconnectUntil(() => expect(scripted.calls).toHaveLength(3))
    const [first, again, settings] = scripted.calls
    expect(first!.key).toStrictEqual(expect.any(String))
    expect([again, settings].map((call) => [call!.method, call!.key])).toStrictEqual([
      ["threads.update", first!.key],
      ["settings.get", undefined],
    ])

    scripted.send({ type: "result", id: again!.id, envelope: { result: { id: "t1", title: "once" } } })
    scripted.send({ type: "result", id: settings!.id, envelope: { result: { textGenerationModel: "m" } } })
    expect(await update).toStrictEqual({ result: { id: "t1", title: "once" } })
    expect(await read).toStrictEqual({ result: { textGenerationModel: "m" } })
    expect(scripted.calls.filter((call) => call.key === first!.key)).toHaveLength(2)
    await remove("flaky")
    scripted.stop()
  })

  test("an overdue offline call is not dispatched when ready arrives before its delayed timeout", async () => {
    const scripted = await pair("late-ready")
    scripted.holdReady()
    scripted.socket().terminate()
    await pushedEventually(statusOf("late-ready", "offline"))
    let answer: RpcEnvelope<unknown> | undefined
    const pending = forward("late-ready", { method: "settings.set", payload: {} }).then((value) => {
      answer = value
    })
    const clock = await clocked.runPromise(
      Effect.gen(function* () {
        return yield* Clock.Clock
      }),
    )
    let restore: (() => void) | undefined
    try {
      await reconnectUntil(() => expect(scripted.hasHeldReady()).toBe(true))
      const jumped = clock.currentTimeMillisUnsafe() + 60_001
      const spy = vi.spyOn(clock, "currentTimeMillisUnsafe").mockReturnValue(jumped)
      restore = () => spy.mockRestore()
      scripted.releaseReady()
      await pushedEventually(statusOf("late-ready", "connected"))
      expect(scripted.calls).toStrictEqual([])
      await vi.waitFor(() =>
        expect(answer).toStrictEqual({
          error: { tag: "Timeout", message: "Not sent. late-ready was unreachable for a minute." },
        }),
      )
    } finally {
      restore?.()
      await remove("late-ready")
      await pending
      scripted.stop()
    }
  })

  test("a call waits through connected time and fails after a minute unreachable", async () => {
    const scripted = await pair("slow")
    let answer: RpcEnvelope<unknown> | undefined
    const update = forward("slow", { method: "threads.update", payload: { id: "t1", title: "slow" } }).then(
      (envelope) => (answer = envelope),
    )
    await vi.waitFor(() => expect(scripted.calls).toHaveLength(1))
    for (let step = 0; step < 12; step++) {
      await adjust("10 seconds")
      const now = new Date(await testTime()).toISOString()
      await vi.waitFor(async () => expect((await listed("slow"))?.lastSeenAt).toBe(now))
    }
    expect(answer).toBeUndefined()

    scripted.stop()
    await pushedEventually(statusOf("slow", "offline"))
    await adjust("59 seconds")
    expect(answer).toBeUndefined()
    await adjust("1 second")
    expect(await update).toStrictEqual({
      error: { tag: "Timeout", message: "slow was unreachable for a minute. The call may still have run there." },
    })
    await remove("slow")
  })

  test("a link silent for 25 seconds is dropped, and removing the cloud fails the calls it held", async () => {
    const scripted = await pair("silent", { autoPong: false })
    await adjust("10 seconds")
    scripted.send({ type: "pong", at: 0 })
    const heardAt = new Date(await testTime()).toISOString()
    await vi.waitFor(async () => expect((await listed("silent"))?.lastSeenAt).toBe(heardAt))

    await adjust(24_999)
    let held: RpcEnvelope<unknown> | undefined
    void forward("silent", { method: "settings.get", payload: undefined }).then((envelope) => (held = envelope))
    await vi.waitFor(() => expect(scripted.calls).toHaveLength(1))
    expect(scripted.socket().readyState).toBe(WebSocket.OPEN)
    await adjust(1)
    await vi.waitFor(() => expect(scripted.socket().readyState).toBe(WebSocket.CLOSED))
    expect(held).toBeUndefined()

    await remove("silent")
    await vi.waitFor(() =>
      expect(held).toStrictEqual({ error: { tag: "NotFoundError", message: "No environment with id silent" } }),
    )
    scripted.stop()
  })

  test("a rotated token fails pending calls and stops retrying", async () => {
    const scripted = await pair("rotated")
    const update = forward("rotated", { method: "threads.update", payload: { id: "t1", title: "x" } })
    await vi.waitFor(() => expect(scripted.calls).toHaveLength(1))
    scripted.socket().close(CLOSE_TOKEN_ROTATED)
    const refused = {
      error: { tag: "EnvironmentUnauthorized", message: "rotated refused this desktop's token. Pair it again." },
    }
    expect(await update).toStrictEqual(refused)
    await pushedEventually(statusOf("rotated", "unauthorized"))
    expect(await forward("rotated", { method: "settings.get", payload: undefined })).toStrictEqual(refused)
    await remove("rotated")
    scripted.stop()
  })

  test("a cloud on a newer protocol fails pending calls, names its version, and reconnects once updated", async () => {
    const scripted = await scriptedCloud("newer", { version: REMOTE_PROTOCOL_VERSION + 1 })
    await add(scripted.pairingUrl)
    await pushedEventually(statusOf("newer", "incompatible"))
    expect(await listed("newer")).toMatchObject({ status: "incompatible", protocol: REMOTE_PROTOCOL_VERSION + 1 })
    expect(await forward("newer", { method: "settings.get", payload: undefined })).toMatchObject({
      error: { tag: "EnvironmentIncompatible" },
    })

    scripted.update()
    await reconnectUntil(() => expect(electron.pushes.some(statusOf("newer", "connected"))).toBe(true))
    expect(await listed("newer")).not.toHaveProperty("protocol")
    await remove("newer")
    scripted.stop()
  })

  test("pairing waits about a second for an earlier host, not the whole probe timeout", async () => {
    const scripted = await scriptedCloud("second-host", {})
    const held: Array<Socket> = []
    const blackhole = createServer((socket) => held.push(socket))
    await new Promise<void>((resolve) => blackhole.listen({ host: "::1", port: scripted.port }, resolve))
    try {
      let added: Awaited<ReturnType<typeof add>> | undefined
      const startedAt = await testTime()
      void add(pairingUrl({ hosts: ["::1", "127.0.0.1"], port: scripted.port, token: "token" })).then(
        (environment) => (added = environment),
      )
      await vi.waitFor(() => expect(held).toHaveLength(1))
      await vi.waitFor(async () => {
        await adjust("100 millis")
        expect(added).toMatchObject({ id: "second-host", host: "127.0.0.1" })
      })
      expect((await testTime()) - startedAt).toBeLessThan(2_000)
      await remove("second-host")
    } finally {
      for (const socket of held) socket.destroy()
      blackhole.close()
      scripted.stop()
    }
  })

  test("pairing keeps an earlier host that answers within a second of a later one", async () => {
    const scripted = await scriptedCloud("both-hosts", {})
    const slow = await scriptedCloud("both-hosts", { host: "::1", port: scripted.port })
    slow.holdReady()
    try {
      let added: Awaited<ReturnType<typeof add>> | undefined
      void add(pairingUrl({ hosts: ["::1", "127.0.0.1"], port: scripted.port, token: "token" })).then(
        (environment) => (added = environment),
      )
      await vi.waitFor(() => expect(scripted.socket()).toBeDefined())
      await vi.waitFor(() => expect(slow.hasHeldReady()).toBe(true))
      await adjust("500 millis")
      expect(added).toBeUndefined()
      slow.releaseReady()
      await vi.waitFor(() => expect(added).toMatchObject({ id: "both-hosts", host: "::1" }))
      await remove("both-hosts")
    } finally {
      slow.stop()
      scripted.stop()
    }
  })

  test("reconnecting skips the backoff, and calls queued meanwhile go out once connected", async () => {
    const scripted = await pair("asleep")
    scripted.socket().terminate()
    await pushedEventually(statusOf("asleep", "offline"))
    const read = forward("asleep", { method: "settings.get", payload: undefined })

    await clocked.runPromise(Environments.use((environments) => environments.reconnectAll))
    await vi.waitFor(() => expect(electron.pushes.filter(statusOf("asleep", "connected"))).toHaveLength(2))
    await vi.waitFor(() => expect(scripted.calls).toHaveLength(1))
    scripted.send({ type: "result", id: scripted.calls[0]!.id, envelope: { result: { textGenerationModel: "m" } } })
    expect(await read).toStrictEqual({ result: { textGenerationModel: "m" } })
    await remove("asleep")
    scripted.stop()
  })

  test("a cloud without call keys gets mutations bare, and one cut off is reported instead of sent twice", async () => {
    const scripted = await pair("old", { features: [] })
    const update = forward("old", { method: "threads.update", payload: { id: "t1", title: "x" } })
    await vi.waitFor(() => expect(scripted.calls).toHaveLength(1))
    expect(scripted.calls[0]).not.toHaveProperty("key")
    scripted.socket().terminate()
    expect(await update).toStrictEqual({
      error: { tag: "EnvironmentOffline", message: "old went offline. The call may still have run there." },
    })
    await reconnectUntil(() => expect(electron.pushes.filter(statusOf("old", "connected"))).toHaveLength(2))
    await vi.waitFor(() => expect(electron.pushes.filter(statusOf("old", "connected"))).toHaveLength(2))
    expect(scripted.calls).toHaveLength(1)
    await remove("old")
    scripted.stop()
  })

  test("closing the desktop fails the calls still waiting, timers included", async () => {
    const scripted = await pair("closing")
    const environments = await clocked.runPromise(Environments.use(Effect.succeed))
    const forwardOutside = (call: ForwardedCall) => Effect.runPromise(environments.forward("closing", call))
    const sent = forwardOutside({ method: "threads.update", payload: { id: "t1", title: "x" } })
    await vi.waitFor(() => expect(scripted.calls).toHaveLength(1))
    scripted.stop()
    await pushedEventually(statusOf("closing", "offline"))
    const queued = forwardOutside({ method: "settings.get", payload: undefined })

    await clocked.dispose()
    const offline = { error: { tag: "EnvironmentOffline", message: "closing is offline" } }
    expect(await Promise.all([sent, queued])).toStrictEqual([offline, offline])
  })
})
