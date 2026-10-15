import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import type { AddressInfo } from "node:net"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, test } from "@effect/vitest"
import { vi } from "vitest"
import { Effect, Layer, ManagedRuntime, Schema, Stream } from "effect"
import { WebSocketServer } from "ws"
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
import { pairingUrl, REMOTE_PATH } from "../../shared/remote.ts"
import { ClaudeProvider } from "../agents/claude/index.ts"
import { CodexProvider } from "../agents/codex/index.ts"
import { MuseProvider } from "../agents/muse/index.ts"
import type { AgentProvider } from "../agents/provider.ts"
import { registerIpc } from "../ipc.ts"
import { RemoteAccess } from "../remote/access.ts"
import { makeTestAppLayer } from "../testing.ts"
import { ClientSettings } from "./ClientSettings.ts"
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

const appUrl = "file:///opt/kkcode/out/renderer/index.html"

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

const cloudPairing = async (token?: string) => {
  const pairing = await cloud.runPromise(RemoteAccess.use((remote) => remote.pairing))
  return pairingUrl("127.0.0.1", pairing.port, token ?? pairing.token)
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
  cloud = ManagedRuntime.make(makeCloud(join(dir, "cloud", "kkcode.sqlite")))
  await setCloudRemote(true)
  await vi.waitFor(async () =>
    expect((await cloud.runPromise(RemoteAccess.use((remote) => remote.status))).listening).toBe(true),
  )
  desktop = ManagedRuntime.make(makeDesktop(join(dir, "desktop", "kkcode.sqlite")))
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
    const wrong = await invoke("environments.add", { name: "home", pairingUrl: await cloudPairing("not-the-token") })
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

  test("a stopped cloud answers EnvironmentOffline and keeps its last projects listed", async () => {
    await setCloudRemote(false)
    await pushedEventually(statusOf(cloudId, "offline"))
    expect(failure(await invoke("threads.update", { id: cloudThread, title: "lost" }))).toStrictEqual({
      tag: "EnvironmentOffline",
      message: "home-server is offline",
    })
    const projects = result(await invoke("projects.list", undefined))
    expect(projects.map((project) => project.name)).toStrictEqual(["here", "there"])
    result(await invoke("threads.update", { id: localThread, title: "still here" }))
  })

  test("removing a cloud forgets it and its token", async () => {
    result(await invoke("environments.remove", { id: cloudId }))
    expect(result(await invoke("environments.list", undefined))).toStrictEqual({ clouds: [] })
    expect(await desktop.runPromise(Secrets.use((secrets) => secrets.has(`environment.${cloudId}.token`)))).toBe(false)
    expect(result(await invoke("projects.list", undefined)).map((project) => project.name)).toStrictEqual(["here"])
  })

  test("a cloud on another protocol version is incompatible and not retried", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0, path: REMOTE_PATH })
    let connections = 0
    server.on("connection", (socket) => {
      connections++
      socket.on("message", () =>
        socket.send(JSON.stringify({ type: "ready", version: 999, environment: { id: "future", name: "future" } })),
      )
    })
    await new Promise((resolve) => server.once("listening", resolve))
    try {
      const { port } = server.address() as AddressInfo
      const added = result(
        await invoke("environments.add", { name: "", pairingUrl: pairingUrl("127.0.0.1", port, "token") }),
      )
      expect(added).toMatchObject({ id: "future", name: "future" })
      await pushedEventually(statusOf("future", "incompatible"))
      expect(connections).toBe(2)
      result(await invoke("environments.remove", { id: "future" }))
    } finally {
      server.close()
    }
  })
})
