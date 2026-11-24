import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createServer as createHttpServer } from "node:http"
import { createServer as createHttpsServer } from "node:https"
import { tmpdir } from "node:os"
import { type AddressInfo, createServer, type Socket } from "node:net"
import { join } from "node:path"
import type { Duplex } from "node:stream"
import { getCACertificates, setDefaultCACertificates } from "node:tls"
import { afterAll, beforeAll, describe, expect, test } from "@effect/vitest"
import { vi } from "vitest"
import { Clock, type Duration, Effect, Layer, ManagedRuntime, Schema, Stream } from "effect"
import { TestClock } from "effect/testing"
import { WebSocket, WebSocketServer } from "ws"
import { SqlClient } from "effect/sql"
import { unlistedModel } from "../../shared/agent.ts"
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js"
import { type Channel, encodeKey, generateKeyPair, type KeyPair, REMOTE_PROLOGUE, respond } from "../../shared/noise.ts"
import type { RelayMachine } from "../../shared/relayMachines.ts"
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
  CLOSE_HANDSHAKE_FAILED,
  CLOSE_PAIRING_RESET,
  CLOSE_UNAUTHORIZED,
  DIRECT_CHECK_INTERVAL_MS,
  pairingUrl,
  RELAY_DELAY_MS,
  REMOTE_PATH,
  REMOTE_PROTOCOL_VERSION,
  type ServerFrame,
} from "../../shared/remote.ts"
import { ClaudeProvider } from "../agents/claude/index.ts"
import { CodexProvider } from "../agents/codex/index.ts"
import { MuseProvider } from "../agents/muse/index.ts"
import { OpencodeProvider } from "../agents/opencode/index.ts"
import { PiProvider } from "../agents/pi/index.ts"
import { MagpieProvider } from "../agents/magpie/index.ts"
import type { AgentProvider } from "../agents/provider.ts"
import { registerIpc } from "../ipc.ts"
import { RemoteAccess } from "../remote/access.ts"
import { unusedLoopbackPort } from "../remote/testing.ts"
import { makeTestAppLayer } from "../testing.ts"
import { Artifacts } from "./Artifacts.ts"
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
  Layer.succeed(PiProvider, provider("pi")),
)

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

const cloudPairing = async (options: { key?: string; hosts?: [string, ...Array<string>] } = {}) => {
  const pairing = await cloud.runPromise(RemoteAccess.use((remote) => remote.pairing))
  return pairingUrl({
    hosts: options.hosts ?? ["127.0.0.1", "192.0.2.1"],
    port: pairing.port,
    relay: null,
    key: options.key ?? pairing.key,
    secret: pairing.secret,
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
  cloudPort = await unusedLoopbackPort()
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
  registerIpc(desktop, appUrl, () => {})
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

  test("refuses a URL that is not a pairing URL and a key the cloud does not hold", async () => {
    expect(failure(await invoke("environments.add", { name: "home", pairingUrl: "https://example.com" })).tag).toBe(
      "InvalidPairingUrl",
    )
    const wrong = await invoke("environments.add", {
      name: "home",
      pairingUrl: await cloudPairing({ key: encodeKey(generateKeyPair().publicKey), hosts: ["127.0.0.1"] }),
    })
    expect(failure(wrong)).toMatchObject({
      tag: "EnvironmentUnauthorized",
      message: expect.stringContaining("did not accept"),
    })
    expect(result(await invoke("environments.list", undefined)).clouds).toStrictEqual([])
  })

  test("pairs a cloud under its own id with the secret once, and pairing again keeps one row", async () => {
    const identity = await cloud.runPromise(RemoteAccess.use((remote) => Effect.succeed(remote.identity)))
    const pairing = await cloud.runPromise(RemoteAccess.use((remote) => remote.pairing))
    const added = result(await invoke("environments.add", { name: "home-server", pairingUrl: await cloudPairing() }))
    expect(added).toMatchObject({ id: identity.id, name: "home-server", host: "127.0.0.1", port: cloudPort })
    cloudId = added.id
    await pushedEventually(statusOf(cloudId, "connected"))
    expect((await cloud.runPromise(RemoteAccess.use((remote) => remote.pairing))).secret).not.toBe(pairing.secret)
    expect((await cloud.runPromise(RemoteAccess.use((remote) => remote.devices))).devices).toHaveLength(1)

    const again = result(await invoke("environments.add", { name: "", pairingUrl: await cloudPairing() }))
    expect(again).toMatchObject({ id: cloudId, name: "home-server" })

    const rows = await desktop.runPromise(
      Effect.flatMap(SqlClient.SqlClient, (sql) => sql`SELECT host_key, verified FROM environment`),
    )
    expect(rows).toStrictEqual([{ hostKey: pairing.key, verified: 1 }])
    expect(await desktop.runPromise(Secrets.use((secrets) => secrets.has(`environment.${cloudId}.token`)))).toBe(false)
    expect((await cloud.runPromise(RemoteAccess.use((remote) => remote.devices))).devices).toHaveLength(1)
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

  test("browser sessions and frames run on the thread's paired cloud", async () => {
    const page = createHttpServer((_request, response) => {
      response.setHeader("content-type", "text/html")
      response.end("<title>Cloud browser</title><h1>Served on the cloud</h1>")
    })
    await new Promise<void>((resolve) => page.listen(0, "127.0.0.1", resolve))
    const address = page.address()
    if (address === null || typeof address === "string") throw new Error("No browser test port")
    let sessionId: string | undefined
    try {
      const opened = result(
        await invoke("browser.open", {
          threadId: cloudThread,
          url: `http://127.0.0.1:${address.port}/`,
          width: 800,
          height: 600,
        }),
      )
      sessionId = opened.sessionId
      const session = { threadId: cloudThread, sessionId }
      await expect
        .poll(async () => result(await invoke("browser.frame", { ...session, after: 0, visible: true })).state.title)
        .toBe("Cloud browser")
      const snapshot = result(await invoke("browser.frame", { ...session, after: 0, visible: true }))
      expect(snapshot.frame?.jpeg).toMatch(/^\/9j\//)
      expect(snapshot.frame).toMatchObject({ width: 800, height: 600 })
      const misplaced = await invoke("browser.frame", { threadId: localThread, sessionId, after: 0, visible: true })
      expect(failure(misplaced).tag).toBe("BrowserError")
      const unsafe = await invoke("browser.command", {
        ...session,
        commands: [{ kind: "navigate", url: "file:///etc/passwd" }],
      })
      expect(failure(unsafe).tag).toBe("SchemaError")
    } finally {
      if (sessionId !== undefined) result(await invoke("browser.close", { threadId: cloudThread, sessionId }))
      await new Promise<void>((resolve, reject) => page.close((error) => (error ? reject(error) : resolve())))
    }
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

  test("a device screenshot from a cloud thread is saved on the desktop for the local file manager", async () => {
    const saved = await electron.handlers.get(RPC_CHANNEL)!(
      { sender: {}, senderFrame: { url: appUrl, parent: null } },
      {
        method: "device.screenshot.save",
        payload: {
          threadId: cloudThread,
          dataUrl: `data:image/png;base64,${Buffer.from("screen bytes").toString("base64")}`,
          name: "Cloud phone.png",
        },
      },
    )
    expect(saved).toMatchObject({
      result: {
        path: expect.stringContaining(join(dir, "desktop", "attachments", cloudThread)),
        name: "Cloud phone.png",
        mime: "image/png",
        bytes: 12,
      },
    })
  })

  test("the file viewer previews a cloud's files from the cloud, inside the root only", async () => {
    writeFileSync(join(cloudRepo, "page.html"), "<h1>cloud</h1>")
    const { dataUrl } = result(await invoke("fs.preview", { root: cloudRepo, path: "page.html" }))
    expect(dataUrl).toBe(`data:text/html;base64,${Buffer.from("<h1>cloud</h1>").toString("base64")}`)
    expect(failure(await invoke("fs.preview", { root: cloudRepo, path: "../picked.png" })).tag).toBe("FsAccessError")
  })

  test("a cloud's artifacts list with its id, open from the cloud, and its pushes reach the window", async () => {
    const page = "<h1>cloud artifact</h1>"
    const published = await cloud.runPromise(
      Artifacts.use((artifacts) =>
        Effect.promise(() =>
          artifacts.store.publish({ title: "Cloud report", files: [{ path: "index.html", content: page }] }),
        ),
      ),
    )
    await pushedEventually(
      (event) =>
        event.type === "artifact.updated" &&
        event.artifact.id === published.id &&
        event.artifact.environmentId === cloudId,
    )

    const listed = result(await invoke("artifacts.list", undefined))
    expect(listed.map((artifact) => [artifact.id, artifact.environmentId])).toStrictEqual([[published.id, cloudId]])
    const { dataUrl } = result(await invoke("artifacts.file", { id: published.id, path: "" }))
    expect(dataUrl).toBe(`data:text/html;charset=utf-8;base64,${Buffer.from(page).toString("base64")}`)
    expect(failure(await invoke("artifacts.file", { id: published.id, path: "gone.html" })).tag).toBe("NotFoundError")
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

  test("moving a cloud's listener over the link it answers on still answers, and the desktop finds it again", async () => {
    const connections = () => electron.pushes.filter(statusOf(cloudId, "connected")).length
    const before = connections()

    const moved = result(await invoke("settings.set", { remote: { bindHost: "private" } }, cloudId))
    expect(moved.remote).toStrictEqual({ enabled: true, bindHost: "private", port: cloudPort })

    await vi.waitFor(() => expect(connections()).toBe(before + 1))
    expect(result(await invoke("settings.get", undefined, cloudId)).remote.bindHost).toBe("private")
    expect(result(await invoke("remote.status", undefined, cloudId))).toMatchObject({ listening: true, connected: 1 })
  })

  test("a device hub on an older release is named as a version mismatch instead of a schema error", async () => {
    const older = await scriptedCloud("older-hub", {})
    result(await invoke("environments.add", { name: "", pairingUrl: older.pairingUrl }))
    await pushedEventually(statusOf("older-hub", "connected"))
    const setDevicesOn = (devicesOn: string | null) =>
      desktop.runPromise(
        Settings.use((settings) =>
          Effect.flatMap(settings.get, ({ experimental }) =>
            settings.set({ experimental: { ...experimental, devices: true, devicesOn } }),
          ),
        ),
      )
    await setDevicesOn("older-hub")
    try {
      const listed = invoke("devices.list", { threadId: localThread })
      await vi.waitFor(() => expect(older.calls.map((call) => call.method)).toContain("devices.list"))
      const call = older.calls.find((each) => each.method === "devices.list")!
      const shapeBeforeChecks = {
        ios: { kind: "ready" },
        android: { kind: "ready" },
        simslim: true,
        devices: [],
        models: [],
      }
      older.send({ type: "result", id: call.id, envelope: { result: shapeBeforeChecks } })

      expect(failure(await listed)).toStrictEqual({ tag: "EnvironmentVersionMismatch", message: "older-hub" })
    } finally {
      await setDevicesOn(null)
      await invoke("environments.remove", { id: "older-hub" })
      older.stop()
    }
  })

  test("a machine on another release drops out of a merged list instead of breaking it", async () => {
    const older = await scriptedCloud("older-desk", {})
    result(await invoke("environments.add", { name: "", pairingUrl: older.pairingUrl }))
    await pushedEventually(statusOf("older-desk", "connected"))
    try {
      const listed = invoke("projects.list", undefined)
      await vi.waitFor(() => expect(older.calls.map((call) => call.method)).toContain("projects.list"))
      const call = older.calls.find((each) => each.method === "projects.list")!
      older.send({ type: "result", id: call.id, envelope: { result: [{ id: "old", title: "from another release" }] } })

      expect(result(await listed).map((project) => project.name)).toStrictEqual(["here", "there"])
    } finally {
      await invoke("environments.remove", { id: "older-desk" })
      older.stop()
    }
  })

  test("removing a cloud forgets it and its pairing secret", async () => {
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
  readonly relay?: string
  readonly tls?: { readonly key: string; readonly cert: string }
  readonly holdUpgrades?: boolean
  readonly answeredUpgrades?: number
  readonly refuse?: boolean
  readonly silentRelay?: boolean
  readonly hostKey?: KeyPair
}

type ScriptedHello = Extract<ClientFrame, { type: "hello" }>

const SCRIPTED_SECRET = "scripted-secret"
const utf8 = new TextDecoder()
const seal = (channel: Channel, frame: ServerFrame) => channel.encrypt(utf8ToBytes(JSON.stringify(frame)))

const scriptedCloud = async (id: string, options: ScriptedOptions) => {
  let version = options.version ?? REMOTE_PROTOCOL_VERSION
  let hostKey = options.hostKey ?? generateKeyPair()
  const http = options.tls === undefined ? createHttpServer() : createHttpsServer(options.tls)
  const server = new WebSocketServer({ noServer: true, autoPong: options.autoPong ?? true })
  const held: Array<Duplex> = []
  const waiting: Array<() => void> = []
  let upgrades = 0
  let dials = 0
  http.on("connection", () => dials++)
  http.on("upgrade", (request, socket, head) => {
    upgrades++
    if (request.url !== REMOTE_PATH) return void socket.destroy()
    if (upgrades > (options.answeredUpgrades ?? Infinity)) return void socket.destroy()
    const answer = () => {
      if (socket.destroyed) return
      server.handleUpgrade(request, socket, head, (ws) => server.emit("connection", ws, request))
    }
    if (!options.holdUpgrades) return answer()
    held.push(socket)
    waiting.push(answer)
    // FIXME: an upgraded socket has left Node's HTTP parser, so a client hang-up only ends its half
    socket.on("end", () => socket.destroy())
  })
  const calls: Array<Extract<ClientFrame, { type: "call" }>> = []
  const hellos: Array<ScriptedHello> = []
  const received: Array<ClientFrame> = []
  const plaintext: Array<string> = []
  let handshakes = 0
  let connections = 0
  let current: { readonly socket: WebSocket; readonly channel: Channel } | undefined
  let holdReady = false
  let heldReady: ServerFrame | undefined
  server.on("connection", (socket) => {
    connections++
    socket.send(JSON.stringify({ type: "challenge", nonce: bytesToHex(generateKeyPair().publicKey) }))
    let channel: Channel | null = null
    socket.on("message", (raw: Buffer, isBinary) => {
      if (!isBinary) return void plaintext.push(String(raw))
      if (channel === null) {
        handshakes++
        try {
          const responder = respond({ prologue: REMOTE_PROLOGUE, local: hostKey, message: raw })
          const replied = responder.reply(new Uint8Array(0))
          channel = replied.channel
          socket.send(replied.message)
        } catch {
          socket.close(CLOSE_HANDSHAKE_FAILED)
        }
        return
      }
      const frame = JSON.parse(utf8.decode(channel.decrypt(raw))) as ClientFrame
      received.push(frame)
      if (frame.type === "call") calls.push(frame)
      if (frame.type !== "hello") return
      hellos.push(frame)
      if (options.refuse) return socket.close(CLOSE_UNAUTHORIZED)
      current = { socket, channel }
      const relay = options.silentRelay
        ? undefined
        : (options.relay ?? (options.tls === undefined ? undefined : `127.0.0.1:${port}`))
      const ready: ServerFrame = {
        type: "ready",
        version,
        environment: { id, name: id },
        features: options.features ?? ["heartbeat", "call-keys", "some-future-feature"],
        ...(relay === undefined ? {} : { relay }),
      }
      if (holdReady) heldReady = ready
      else socket.send(seal(channel, ready))
    })
  })
  await new Promise<void>((resolve) =>
    http.listen({ host: options.host ?? "127.0.0.1", port: options.port ?? 0 }, resolve),
  )
  const { port } = http.address() as AddressInfo
  return {
    port,
    relay: `127.0.0.1:${port}`,
    hostKey: () => hostKey,
    pairingUrl: pairingUrl({
      hosts: ["127.0.0.1"],
      port,
      relay: null,
      key: encodeKey(hostKey.publicKey),
      secret: SCRIPTED_SECRET,
    }),
    calls,
    hellos,
    received,
    plaintext,
    handshakes: () => handshakes,
    connections: () => connections,
    upgrades: () => upgrades,
    dials: () => dials,
    held,
    answerHeld: () => {
      for (const answer of waiting.splice(0)) answer()
    },
    holdReady: () => {
      holdReady = true
    },
    hasHeldReady: () => heldReady !== undefined,
    rekey: () => {
      hostKey = generateKeyPair()
    },
    releaseReady: () => {
      current!.socket.send(seal(current!.channel, heldReady!))
      heldReady = undefined
    },
    update: () => {
      version = REMOTE_PROTOCOL_VERSION
    },
    socket: () => current!.socket,
    send: (frame: ServerFrame) => current!.socket.send(seal(current!.channel, frame)),
    stop: () => {
      http.close()
      for (const socket of server.clients) socket.terminate()
      for (const socket of held) socket.destroy()
    },
  }
}

const trustedLoopbackCertificate = () => {
  const key = join(dir, "relay-key.pem")
  const cert = join(dir, "relay-cert.pem")
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:prime256v1",
      "-nodes",
      "-days",
      "1",
      "-subj",
      "/CN=127.0.0.1",
      "-addext",
      "subjectAltName=IP:127.0.0.1",
      "-keyout",
      key,
      "-out",
      cert,
    ],
    { stdio: "ignore" },
  )
  const tls = { key: readFileSync(key, "utf8"), cert: readFileSync(cert, "utf8") }
  setDefaultCACertificates([...getCACertificates("default"), tls.cert])
  return tls
}

describe("desktop environments over a flaky link", () => {
  let clocked: ManagedRuntime.ManagedRuntime<Environments | TestClock.TestClock, unknown>
  let tls: { readonly key: string; readonly cert: string }

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
    tls = trustedLoopbackCertificate()
    mkdirSync(join(dir, "clocked"))
    clocked = ManagedRuntime.make(
      makeDesktop(join(dir, "clocked", "hinacode.sqlite")).pipe(Layer.provideMerge(TestClock.layer())),
    )
  })

  afterAll(() => clocked.dispose())

  test("a mutation whose answer was lost is sent again once under the same key, ahead of calls made offline", async () => {
    const scripted = await pair("flaky")
    const update = forward("flaky", { method: "projects.delete", payload: { id: "p1" } })
    await vi.waitFor(() => expect(scripted.calls).toHaveLength(1))
    scripted.socket().terminate()
    await pushedEventually(statusOf("flaky", "offline"))
    const read = forward("flaky", { method: "projects.list", payload: undefined })

    await reconnectUntil(() => expect(scripted.calls).toHaveLength(3))
    const [first, again, list] = scripted.calls
    expect(first!.key).toStrictEqual(expect.any(String))
    expect([again, list].map((call) => [call!.method, call!.key])).toStrictEqual([
      ["projects.delete", first!.key],
      ["projects.list", undefined],
    ])

    scripted.send({ type: "result", id: again!.id, envelope: { result: null } })
    scripted.send({ type: "result", id: list!.id, envelope: { result: [] } })
    expect(await update).toStrictEqual({ result: null })
    expect(await read).toStrictEqual({ result: [] })
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

  test("a pairing reset fails pending calls and stops retrying", async () => {
    const scripted = await pair("rotated")
    const update = forward("rotated", { method: "threads.update", payload: { id: "t1", title: "x" } })
    await vi.waitFor(() => expect(scripted.calls).toHaveLength(1))
    scripted.socket().close(CLOSE_PAIRING_RESET)
    const refused = {
      error: { tag: "EnvironmentUnauthorized", message: "rotated reset its pairing. Pair it again." },
    }
    expect(await update).toStrictEqual(refused)
    await pushedEventually(statusOf("rotated", "unauthorized"))
    expect(await listed("rotated")).toMatchObject({ status: "unauthorized", refusal: "reset" })
    expect(await forward("rotated", { method: "settings.get", payload: undefined })).toStrictEqual(refused)
    await remove("rotated")
    scripted.stop()
  })

  test("a machine that removed this device stops the link as removed", async () => {
    const scripted = await pair("removed-me")
    scripted.socket().close(CLOSE_UNAUTHORIZED)
    await pushedEventually(statusOf("removed-me", "unauthorized"))
    expect(await listed("removed-me")).toMatchObject({ refusal: "removed" })
    await adjust("2 minutes")
    expect(scripted.handshakes()).toBe(2)
    await remove("removed-me")
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
      void add(
        pairingUrl({
          hosts: ["::1", "127.0.0.1"],
          port: scripted.port,
          relay: null,
          key: encodeKey(scripted.hostKey().publicKey),
          secret: null,
        }),
      ).then((environment) => (added = environment))
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
    const slow = await scriptedCloud("both-hosts", { host: "::1", port: scripted.port, hostKey: scripted.hostKey() })
    slow.holdReady()
    try {
      let added: Awaited<ReturnType<typeof add>> | undefined
      void add(
        pairingUrl({
          hosts: ["::1", "127.0.0.1"],
          port: scripted.port,
          relay: null,
          key: encodeKey(scripted.hostKey().publicKey),
          secret: null,
        }),
      ).then((environment) => (added = environment))
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

  test("a pairing whose relay refuses still connects over its host and keeps the relay", async () => {
    const scripted = await scriptedCloud("relay-down", { relay: "127.0.0.1" })
    const url = pairingUrl({
      hosts: ["127.0.0.1"],
      port: scripted.port,
      relay: "127.0.0.1",
      key: encodeKey(scripted.hostKey().publicKey),
      secret: null,
    })
    try {
      expect(await add(url)).toMatchObject({ id: "relay-down", host: "127.0.0.1", relay: "127.0.0.1" })
      await pushedEventually(statusOf("relay-down", "connected"))
      expect(await listed("relay-down")).toMatchObject({ relay: "127.0.0.1", status: "connected" })

      scripted.stop()
      await expect(add(url)).rejects.toThrow(`Nothing is listening on 127.0.0.1:${scripted.port}`)
    } finally {
      await remove("relay-down")
      scripted.stop()
    }
  })

  test("a ready naming a relay updates the row, and a relay that fails falls back to the host", async () => {
    const scripted = await pair("learns-relay", { relay: "127.0.0.1" })
    await vi.waitFor(async () => expect(await listed("learns-relay")).toMatchObject({ relay: "127.0.0.1" }))
    expect(scripted.socket().readyState).toBe(WebSocket.OPEN)

    scripted.stop()
    await pushedEventually(statusOf("learns-relay", "offline"))
    const cut: Array<Socket> = []
    const cutting = createServer((socket) => {
      cut.push(socket)
      socket.destroy()
    })
    await new Promise<void>((resolve) => cutting.listen({ host: "127.0.0.1", port: scripted.port }, resolve))
    await reconnectUntil(() => expect(cut.length).toBeGreaterThan(0))
    await new Promise((resolve) => cutting.close(resolve))
    const back = await scriptedCloud("learns-relay", {
      port: scripted.port,
      relay: "127.0.0.1",
      hostKey: scripted.hostKey(),
    })
    try {
      await reconnectUntil(() => expect(electron.pushes.filter(statusOf("learns-relay", "connected"))).toHaveLength(2))
    } finally {
      await remove("learns-relay")
      back.stop()
    }
  })

  test("reconnecting skips the backoff, and calls queued meanwhile go out once connected", async () => {
    const scripted = await pair("asleep")
    scripted.socket().terminate()
    await pushedEventually(statusOf("asleep", "offline"))
    const read = forward("asleep", { method: "projects.list", payload: undefined })

    await clocked.runPromise(Environments.use((environments) => environments.reconnectAll))
    await vi.waitFor(() => expect(electron.pushes.filter(statusOf("asleep", "connected"))).toHaveLength(2))
    await vi.waitFor(() => expect(scripted.calls).toHaveLength(1))
    scripted.send({ type: "result", id: scripted.calls[0]!.id, envelope: { result: [] } })
    expect(await read).toStrictEqual({ result: [] })
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

  test("connects to the direct address when it and the relay both answer, and never says hello to the relay", async () => {
    const relay = await scriptedCloud("both-routes", { tls })
    const direct = await pair("both-routes", { relay: relay.relay, hostKey: relay.hostKey() })
    await vi.waitFor(async () => expect(await listed("both-routes")).toMatchObject({ relay: relay.relay }))

    direct.socket().terminate()
    await pushedEventually(statusOf("both-routes", "offline"))
    await clocked.runPromise(Environments.use((environments) => environments.reconnectAll))
    await vi.waitFor(() => expect(electron.pushes.filter(statusOf("both-routes", "connected"))).toHaveLength(2))
    await adjust("1 second")
    expect(direct.socket().readyState).toBe(WebSocket.OPEN)
    expect(relay.hellos).toStrictEqual([])
    await remove("both-routes")
    relay.stop()
    direct.stop()
  })

  const pairThenLoseDirect = async (id: string, relayed: Awaited<ReturnType<typeof scriptedCloud>>) => {
    const { relay } = relayed
    const direct = await pair(id, { relay, hostKey: relayed.hostKey() })
    await vi.waitFor(async () => expect(await listed(id)).toMatchObject({ relay }))
    direct.stop()
    await pushedEventually(statusOf(id, "offline"))
    return direct.port
  }

  const connectedTimes = (id: string, times: number) =>
    vi.waitFor(async () => {
      await adjust("500 millis")
      expect(electron.pushes.filter(statusOf(id, "connected"))).toHaveLength(times)
    })

  const passHeard = async (id: string, ms: number) => {
    for (let passed = 0; passed < ms; passed += 10_000) {
      const before = await testTime()
      await adjust("10 seconds")
      await vi.waitFor(async () => expect(Date.parse((await listed(id))?.lastSeenAt ?? "")).toBeGreaterThan(before))
    }
  }

  test("connects through the relay while the direct address hangs, and closes that socket unsent", async () => {
    const relay = await scriptedCloud("hung-direct", { tls })
    const port = await pairThenLoseDirect("hung-direct", relay)
    const hung = await scriptedCloud("hung-direct", { port, holdUpgrades: true, hostKey: relay.hostKey() })
    try {
      await connectedTimes("hung-direct", 2)
      expect(relay.hellos).toHaveLength(1)
      expect(hung.held.length).toBeGreaterThan(0)
      await vi.waitFor(() => expect(hung.held.every((socket) => socket.destroyed)).toBe(true))

      const read = forward("hung-direct", { method: "projects.list", payload: undefined })
      await vi.waitFor(() => expect(relay.calls).toHaveLength(1))
      relay.send({ type: "result", id: relay.calls[0]!.id, envelope: { result: [] } })
      expect(await read).toStrictEqual({ result: [] })
    } finally {
      await remove("hung-direct")
      relay.stop()
      hung.stop()
    }
  })

  test("a ready that names no relay keeps the relay it arrived through", async () => {
    const relay = await scriptedCloud("quiet-relay", { tls, silentRelay: true })
    await pairThenLoseDirect("quiet-relay", relay)
    try {
      await connectedTimes("quiet-relay", 2)
      expect(relay.hellos).toHaveLength(1)
      expect(await listed("quiet-relay")).toMatchObject({ relay: relay.relay })
    } finally {
      await remove("quiet-relay")
      relay.stop()
    }
  })

  test("hooks hear a cloud's pushes, and mutations made while it is offline", async () => {
    const pushed: Array<string> = []
    const answered: Array<string> = []
    const offline: Array<string> = []
    await clocked.runPromise(
      Environments.use((environments) =>
        environments.hook({
          pushed: (id, event) => Effect.sync(() => void pushed.push(`${id} ${event.type}`)),
          answered: (id, method) => Effect.sync(() => void answered.push(`${id} ${method}`)),
          offlineMutation: (id) => Effect.sync(() => void offline.push(id)),
        }),
      ),
    )
    const scripted = await pair("hooked")
    try {
      scripted.send({ type: "event", event: { type: "thread.removed", id: "t1" } })
      await vi.waitFor(() => expect(pushed).toStrictEqual(["hooked thread.removed"]))
      const settle = forward("hooked", { method: "threads.settle", payload: { threadId: "t1" } })
      await vi.waitFor(() => expect(scripted.calls).toHaveLength(1))
      scripted.send({ type: "result", id: scripted.calls[0]!.id, envelope: { result: { id: "t1" } } })
      await settle
      expect(answered).toStrictEqual(["hooked threads.settle"])
      scripted.stop()
      await pushedEventually(statusOf("hooked", "offline"))
      void forward("hooked", { method: "settings.get", payload: undefined })
      void forward("hooked", { method: "threads.update", payload: { id: "t1", title: "later" } })
      await vi.waitFor(() => expect(offline).toStrictEqual(["hooked"]))
    } finally {
      await remove("hooked")
    }
  })

  test("moves from the relay to the direct address within a minute of it answering", async () => {
    const relay = await scriptedCloud("to-direct", { tls })
    const port = await pairThenLoseDirect("to-direct", relay)
    await connectedTimes("to-direct", 2)
    const relaySession = relay.socket()
    const direct = await scriptedCloud("to-direct", { port, relay: relay.relay, hostKey: relay.hostKey() })
    try {
      await passHeard("to-direct", DIRECT_CHECK_INTERVAL_MS - 10_000)
      expect(direct.connections()).toBe(0)
      expect(relaySession.readyState).toBe(WebSocket.OPEN)

      await adjust("10 seconds")
      await vi.waitFor(() => expect(direct.hellos).toHaveLength(1))
      expect(direct.connections()).toBe(3)
      await vi.waitFor(() => expect(relaySession.readyState).toBe(WebSocket.CLOSED))
      const read = forward("to-direct", { method: "projects.list", payload: undefined })
      await vi.waitFor(() => expect(direct.calls).toHaveLength(1))
      direct.send({ type: "result", id: direct.calls[0]!.id, envelope: { result: [] } })
      expect(await read).toStrictEqual({ result: [] })
      expect(relay.calls).toStrictEqual([])
    } finally {
      await remove("to-direct")
      relay.stop()
      direct.stop()
    }
  })

  test("a stranger at the direct address fails the handshake and leaves the link on the relay until it drops", async () => {
    const relay = await scriptedCloud("stranger", { tls })
    const port = await pairThenLoseDirect("stranger", relay)
    const stranger = await scriptedCloud("someone-else", { port })
    try {
      await connectedTimes("stranger", 2)
      expect(relay.hellos).toHaveLength(1)
      expect(stranger.handshakes()).toBe(1)
      expect(stranger.received).toStrictEqual([])
      expect(stranger.plaintext).toStrictEqual([])
      expect(stranger.connections()).toBe(2)
      await passHeard("stranger", 2 * DIRECT_CHECK_INTERVAL_MS)
      expect(stranger.connections()).toBe(2)

      relay.socket().terminate()
      await pushedEventually(statusOf("stranger", "offline"))
      await connectedTimes("stranger", 3)
      expect(stranger.connections()).toBe(4)
      expect(relay.hellos).toHaveLength(2)
      expect(electron.pushes.some(statusOf("stranger", "unauthorized"))).toBe(false)
    } finally {
      await remove("stranger")
      relay.stop()
      stranger.stop()
    }
  })

  test("a direct address that opens but never says ready leaves the link on the relay", async () => {
    const relay = await scriptedCloud("stuck-direct", { tls })
    const port = await pairThenLoseDirect("stuck-direct", relay)
    const stuck = await scriptedCloud("stuck-direct", { port, hostKey: relay.hostKey() })
    stuck.holdReady()
    try {
      await vi.waitFor(async () => {
        await adjust("500 millis")
        expect(stuck.hasHeldReady()).toBe(true)
      })
      await adjust("10 seconds")
      await connectedTimes("stuck-direct", 2)
      expect(relay.hellos).toHaveLength(1)
    } finally {
      await remove("stuck-direct")
      relay.stop()
      stuck.stop()
    }
  })

  test("a machine with another key stops the link as refused, and its old pairing URL no longer adds it", async () => {
    const scripted = await pair("rekeyed")
    try {
      scripted.rekey()
      scripted.socket().terminate()
      await pushedEventually(statusOf("rekeyed", "offline"))
      await clocked.runPromise(Environments.use((environments) => environments.reconnectAll))
      await pushedEventually(statusOf("rekeyed", "unauthorized"))
      expect(await listed("rekeyed")).toMatchObject({ refusal: "refused" })
      expect(electron.pushes.filter(statusOf("rekeyed", "connected"))).toHaveLength(1)
      await expect(add(scripted.pairingUrl)).rejects.toThrow("did not accept this device")
    } finally {
      await remove("rekeyed")
      scripted.stop()
    }
  })

  test("a handshake that fails over the relay stops the link as refused", async () => {
    const relay = await scriptedCloud("relay-rekeyed", { tls })
    await pairThenLoseDirect("relay-rekeyed", relay)
    relay.rekey()
    try {
      await vi.waitFor(async () => {
        await adjust("500 millis")
        expect(electron.pushes.some(statusOf("relay-rekeyed", "unauthorized"))).toBe(true)
      })
      await adjust("2 minutes")
      expect(relay.handshakes()).toBe(1)
      expect(await listed("relay-rekeyed")).toMatchObject({ refusal: "refused" })
    } finally {
      await remove("relay-rekeyed")
      relay.stop()
    }
  })

  test("a refusal over the relay still stops the link as unauthorized", async () => {
    const relay = await scriptedCloud("relay-refuses", { tls, refuse: true })
    await pairThenLoseDirect("relay-refuses", relay)
    try {
      await vi.waitFor(async () => {
        await adjust("500 millis")
        expect(electron.pushes.some(statusOf("relay-refuses", "unauthorized"))).toBe(true)
      })
      await adjust("2 minutes")
      expect(relay.hellos).toHaveLength(1)
    } finally {
      await remove("relay-refuses")
      relay.stop()
    }
  })

  test("once the minute check finds a direct address slower than the relay, the next round dials it alone", async () => {
    const relay = await scriptedCloud("slow-direct", { tls })
    const port = await pairThenLoseDirect("slow-direct", relay)
    const direct = await scriptedCloud("slow-direct", {
      port,
      relay: relay.relay,
      holdUpgrades: true,
      hostKey: relay.hostKey(),
    })
    try {
      await connectedTimes("slow-direct", 2)
      expect(relay.hellos).toHaveLength(1)
      const relaySession = relay.socket()
      const relayDials = relay.dials()

      await passHeard("slow-direct", DIRECT_CHECK_INTERVAL_MS - 10_000)
      const raced = direct.upgrades()
      await adjust("10 seconds")
      await vi.waitFor(() => expect(direct.upgrades()).toBe(raced + 1))
      direct.answerHeld()
      await vi.waitFor(() => expect(relaySession.readyState).toBe(WebSocket.CLOSED))
      await vi.waitFor(() => expect(direct.upgrades()).toBe(raced + 2))
      await adjust("1 second")
      await vi.waitFor(() => {
        direct.answerHeld()
        expect(direct.hellos).toHaveLength(1)
      })
      expect(relay.dials()).toBe(relayDials)
      expect(relay.hellos).toHaveLength(1)
    } finally {
      await remove("slow-direct")
      relay.stop()
      direct.stop()
    }
  })

  test("a direct address gone between the minute check and its round falls back to the relay without a backoff", async () => {
    const relay = await scriptedCloud("gone-direct", { tls })
    const port = await pairThenLoseDirect("gone-direct", relay)
    await connectedTimes("gone-direct", 2)
    const direct = await scriptedCloud("gone-direct", { port, answeredUpgrades: 1, hostKey: relay.hostKey() })
    try {
      await passHeard("gone-direct", DIRECT_CHECK_INTERVAL_MS - 10_000)
      await adjust("10 seconds")
      await vi.waitFor(() => expect(direct.upgrades()).toBe(3))
      await adjust(RELAY_DELAY_MS)
      await vi.waitFor(() => expect(relay.hellos).toHaveLength(2))
    } finally {
      await remove("gone-direct")
      relay.stop()
      direct.stop()
    }
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

const syncRelay = (machines: ReadonlyArray<RelayMachine>) =>
  desktop.runPromise(Environments.use((environments) => environments.syncRelay(machines)))
const listedClouds = async () =>
  (await desktop.runPromise(Environments.use((environments) => environments.list))).clouds
const storedKey = async (id: string) => {
  const rows = await desktop.runPromise(
    Effect.flatMap(
      SqlClient.SqlClient,
      (sql) =>
        sql<{ hostKey: string | null; verified: number }>`SELECT host_key, verified FROM environment WHERE id = ${id}`,
    ),
  )
  return rows[0] ?? null
}
const RELAY_KEY = encodeKey(generateKeyPair().publicKey)
const machine = (environmentId: string, pairing: Partial<RelayMachine["pairing"]> = {}): RelayMachine => ({
  environmentId,
  name: `${environmentId} on the relay`,
  pairing: {
    hosts: ["192.0.2.1"],
    port: 48081,
    key: RELAY_KEY,
    relay: `${environmentId}.relay.invalid`,
    ...pairing,
  },
})

describe("desktop environments from the relay", () => {
  test("adds every listed machine but this desktop without dialing it first, unverified, and tells the window", async () => {
    const self = await desktop.runPromise(RemoteAccess.use((remote) => Effect.succeed(remote.identity.id)))
    const changes = electron.pushes.filter((event) => event.type === "environments.changed").length

    await syncRelay([machine("home-server"), machine(self)])

    expect(await listedClouds()).toMatchObject([
      {
        id: "home-server",
        name: "home-server on the relay",
        host: "192.0.2.1",
        port: 48081,
        relay: "home-server.relay.invalid",
        source: "relay",
      },
    ])
    expect(await storedKey("home-server")).toStrictEqual({ hostKey: RELAY_KEY, verified: 0 })
    expect(electron.pushes.filter((event) => event.type === "environments.changed").length).toBeGreaterThan(changes)
  })

  test("keeps the name the user gave a relay machine and its key when the relay changes them", async () => {
    const changes = electron.pushes.filter((event) => event.type === "environments.changed").length

    await desktop.runPromise(Environments.use((environments) => environments.rename("home-server", "Studio")))
    expect(electron.pushes.filter((event) => event.type === "environments.changed").length).toBeGreaterThan(changes)
    const swapped = encodeKey(generateKeyPair().publicKey)
    await syncRelay([{ ...machine("home-server", { key: swapped }), name: "home-server.local" }])

    expect((await listedClouds()).find((entry) => entry.id === "home-server")).toMatchObject({
      name: "Studio",
      source: "relay",
    })
    expect(await storedKey("home-server")).toStrictEqual({ hostKey: RELAY_KEY, verified: 0 })

    await desktop.runPromise(Environments.use((environments) => environments.repair("home-server")))
    expect(await storedKey("home-server")).toStrictEqual({ hostKey: swapped, verified: 0 })
  })

  test("refreshes a paired machine's address, and keeps its key, name and source", async () => {
    const scripted = await scriptedCloud("paired-laptop", {})
    await desktop.runPromise(
      Environments.use((environments) => environments.add({ name: "my laptop", pairingUrl: scripted.pairingUrl })),
    )
    await pushedEventually(statusOf("paired-laptop", "connected"))
    scripted.stop()
    await pushedEventually(statusOf("paired-laptop", "offline"))

    await syncRelay([machine("home-server"), machine("paired-laptop", { hosts: ["localhost"] })])

    expect((await listedClouds()).find((entry) => entry.id === "paired-laptop")).toMatchObject({
      name: "my laptop",
      host: "localhost",
      port: 48081,
      relay: "paired-laptop.relay.invalid",
      source: "pairing",
    })
    expect(await storedKey("paired-laptop")).toStrictEqual({
      hostKey: encodeKey(scripted.hostKey().publicKey),
      verified: 1,
    })
  })

  test("drops a relay machine the list lost and keeps a paired one", async () => {
    await syncRelay([])

    expect((await listedClouds()).map((entry) => entry.id)).toStrictEqual(["paired-laptop"])
    expect(await storedKey("home-server")).toBeNull()
    await desktop.runPromise(Environments.use((environments) => environments.remove("paired-laptop")))
  })
})

const cloudMachine = async (key?: string): Promise<RelayMachine> => {
  const identity = await cloud.runPromise(RemoteAccess.use((remote) => Effect.succeed(remote.identity)))
  const pairing = await cloud.runPromise(RemoteAccess.use((remote) => remote.pairing))
  return {
    environmentId: identity.id,
    name: "studio",
    pairing: { hosts: ["127.0.0.1"], port: pairing.port, key: key ?? pairing.key, relay: "studio.relay.invalid" },
  }
}
const listedCloud = async (id: string) => (await listedClouds()).find((entry) => entry.id === id)

describe("desktop environments approving a machine it learned from the relay", () => {
  test("waits for the code on the machine and the answer here before any call goes out", async () => {
    const relayed = await cloudMachine()
    const id = relayed.environmentId
    await syncRelay([relayed])
    await vi.waitFor(async () =>
      expect(await listedCloud(id)).toMatchObject({ status: "approval", approval: { accepted: false } }),
    )
    const { approval } = (await listedCloud(id))!
    const connectedBefore = electron.pushes.filter(statusOf(id, "connected")).length
    const settings = invoke("settings.get", undefined, id)

    const approved = await cloud.runPromise(RemoteAccess.use((remote) => remote.approve(approval!.code)))
    expect(approved.name).toBeTruthy()
    await vi.waitFor(async () =>
      expect(await listedCloud(id)).toMatchObject({ status: "approval", approval: { accepted: true } }),
    )
    expect(electron.pushes.filter(statusOf(id, "connected"))).toHaveLength(connectedBefore)

    result(await invoke("environments.confirmHost", { id, accepted: true }))
    await pushedEventually(statusOf(id, "connected"))
    expect(result(await settings).remote.port).toBe(cloudPort)
    expect(await storedKey(id)).toMatchObject({ verified: 1 })
  })

  test("a verified machine reconnects without a code, and relay sync with another key keeps it", async () => {
    const relayed = await cloudMachine(encodeKey(generateKeyPair().publicKey))
    const id = relayed.environmentId
    const before = await storedKey(id)
    await syncRelay([relayed])
    expect(await storedKey(id)).toStrictEqual(before)
    result(await invoke("remote.status", undefined, id))
    const connectedBefore = electron.pushes.filter(statusOf(id, "connected")).length
    await setCloudRemote(false)
    await vi.waitFor(async () => expect(await listedCloud(id)).toMatchObject({ status: "offline" }))
    await setCloudRemote(true)
    await vi.waitFor(
      () => expect(electron.pushes.filter(statusOf(id, "connected")).length).toBeGreaterThan(connectedBefore),
      { timeout: 15_000 },
    )
    expect(await listedCloud(id)).not.toHaveProperty("approval")
  })

  test("answering no stops the link as refused", async () => {
    const relayed = await cloudMachine()
    const id = relayed.environmentId
    await desktop.runPromise(Environments.use((environments) => environments.remove(id)))
    await syncRelay([relayed])
    await vi.waitFor(async () => expect(await listedCloud(id)).toMatchObject({ status: "approval" }))
    const { approval } = (await listedCloud(id))!
    await cloud.runPromise(RemoteAccess.use((remote) => remote.approve(approval!.code)))
    await vi.waitFor(async () => expect(await listedCloud(id)).toMatchObject({ approval: { accepted: true } }))

    result(await invoke("environments.confirmHost", { id, accepted: false }))
    await vi.waitFor(async () =>
      expect(await listedCloud(id)).toMatchObject({ status: "unauthorized", refusal: "refused" }),
    )
    expect(failure(await invoke("settings.get", undefined, id)).tag).toBe("EnvironmentUnauthorized")
    await syncRelay([])
  })
})
