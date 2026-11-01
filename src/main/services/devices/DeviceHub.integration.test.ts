import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer, ManagedRuntime, Schema, Stream } from "effect"
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest"
import { unlistedModel } from "../../../shared/agent.ts"
import { PushEvent } from "../../../shared/contract.ts"
import type { Device, DeviceCommand, DeviceId } from "../../../shared/device.ts"
import { pairingUrl } from "../../../shared/remote.ts"
import { ClaudeProvider } from "../../agents/claude/index.ts"
import { CodexProvider } from "../../agents/codex/index.ts"
import { MuseProvider } from "../../agents/muse/index.ts"
import type { AgentProvider } from "../../agents/provider.ts"
import { RemoteAccess } from "../../remote/access.ts"
import { Peers } from "../../remote/peers.ts"
import { unusedLoopbackPort } from "../../remote/testing.ts"
import { makeTestAppLayer } from "../../testing.ts"
import { Events, PushBroadcast, WindowPush } from "../Events.ts"
import { Projects } from "../Projects.ts"
import { Settings } from "../Settings.ts"
import { Threads } from "../Threads.ts"
import { DeviceHub } from "./DeviceHub.ts"
import { Devices } from "./Devices.ts"
import type { DevicePlatformDriver } from "./platform.ts"
import { unavailableDriver } from "./unavailable.ts"

const HUB_DEVICE: DeviceId = "ios:11111111-1111-1111-1111-111111111111"

const hubSimulator: Device = {
  id: HUB_DEVICE,
  platform: "ios",
  name: "Mac's iPhone",
  osVersion: "iOS 27.0",
  state: "booted",
  slim: null,
  memoryBytes: null,
  ownerThreadId: null,
}

const sent: Array<{ readonly deviceId: DeviceId; readonly command: DeviceCommand }> = []

const fakeIos: DevicePlatformDriver = {
  ...unavailableDriver({ kind: "ready" }),
  list: () => Promise.resolve([hubSimulator]),
  boot: () => Promise.resolve(),
  connect: (id, onFrame) => {
    onFrame({
      mime: "image/jpeg",
      data: Buffer.from("frame from the mac"),
      width: 2,
      height: 4,
      orientation: "portrait",
    })
    return Promise.resolve({
      screen: { width: 1, height: 2, scale: 2 },
      send: (commands) => Promise.resolve(void sent.push(...commands.map((command) => ({ deviceId: id, command })))),
      ended: new Promise<string>(() => {}),
      close: () => Promise.resolve(),
    })
  },
}

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
  respondApproval: () => Effect.succeed(false),
  respondQuestion: () => Effect.void,
  setAccessMode: () => Effect.void,
})

const providers = Layer.mergeAll(
  Layer.succeed(ClaudeProvider, provider("claude")),
  Layer.succeed(CodexProvider, provider("codex")),
  Layer.succeed(MuseProvider, provider("muse")),
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

const makeHub = (dbPath: string) =>
  makeTestAppLayer(dbPath, {
    providers,
    events: makeCloudEvents(),
    cloud: true,
    deviceDrivers: { ios: fakeIos, android: unavailableDriver({ kind: "missing", tool: "androidSdk" }) },
  })
const makeClient = (dbPath: string) => makeTestAppLayer(dbPath, { providers, events: makeCloudEvents(), cloud: true })
type Runtime = ManagedRuntime.ManagedRuntime<Layer.Success<ReturnType<typeof makeClient>>, unknown>

let dir = ""
let hub: Runtime
let client: Runtime
let hubPairingUrl = ""
let clientThread = ""

const listDevices = () => client.runPromise(Devices.use((devices) => devices.list()))

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "kk-device-hub-test-"))
  const repo = join(dir, "client-repo")
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
  mkdirSync(join(dir, "hub"))
  mkdirSync(join(dir, "client"))

  const hubPort = await unusedLoopbackPort()
  hub = ManagedRuntime.make(makeHub(join(dir, "hub", "hinacode.sqlite")))
  await hub.runPromise(
    Settings.use((settings) => settings.set({ remote: { enabled: true, bindHost: "127.0.0.1", port: hubPort } })),
  )
  await vi.waitFor(async () =>
    expect((await hub.runPromise(RemoteAccess.use((remote) => remote.status))).listening).toBe(true),
  )
  const pairing = await hub.runPromise(RemoteAccess.use((remote) => remote.pairing))
  hubPairingUrl = pairingUrl({ hosts: ["127.0.0.1"], port: pairing.port, token: pairing.token, relay: null })

  client = ManagedRuntime.make(makeClient(join(dir, "client", "hinacode.sqlite")))
  await client.runPromise(
    Settings.use((settings) =>
      Effect.flatMap(settings.get, (current) =>
        settings.set({ experimental: { ...current.experimental, devices: true } }),
      ),
    ),
  )
  await vi.waitFor(async () =>
    expect(await client.runPromise(Devices.use((devices) => Effect.succeed(devices.enabled())))).toBe(true),
  )

  const project = await client.runPromise(
    Projects.use((projects) => projects.create({ name: "web", rootPath: repo, setupScript: null })),
  )
  clientThread = (
    await client.runPromise(
      Threads.use((threads) =>
        threads.create({ projectId: project.id, title: "uses the mac", provider: "claude", model: "claude-model" }),
      ),
    )
  ).id
}, 60_000)

afterAll(async () => {
  await client.dispose()
  await hub.dispose()
  rmSync(dir, { recursive: true, force: true })
})

describe("device hub", () => {
  test("the client lists the hub's simulators once it links the hub", async () => {
    expect((await listDevices()).ios).toStrictEqual({ kind: "missing", tool: "xcode" })

    const linked = await client.runPromise(DeviceHub.use((deviceHub) => deviceHub.link(hubPairingUrl)))
    await vi.waitFor(async () =>
      expect(await client.runPromise(DeviceHub.use((deviceHub) => deviceHub.status))).toStrictEqual({
        environmentId: linked.environmentId,
        name: linked.name,
        status: "connected",
      }),
    )

    await vi.waitFor(async () => {
      const listed = await listDevices()
      expect(listed.ios).toStrictEqual({ kind: "ready" })
      expect(listed.devices).toStrictEqual([hubSimulator])
    })
  })

  test("a client thread attaches the hub's simulator and sees its frames", async () => {
    const attached = await client.runPromise(Devices.use((devices) => devices.attach(clientThread, HUB_DEVICE)))
    expect(attached.phase).toBe("ready")

    await vi.waitFor(async () => {
      const { frame } = await client.runPromise(
        Devices.use((devices) =>
          devices.frame({ threadId: clientThread, deviceId: HUB_DEVICE, after: 0, visible: true }),
        ),
      )
      expect(frame).not.toBeNull()
      expect(Buffer.from(frame!.data, "base64").toString()).toBe("frame from the mac")
    })
  })

  test("the client's agent input reaches the hub's driver", async () => {
    const touch: DeviceCommand = { kind: "touch", phase: "down", x: 0.5, y: 0.5 }
    sent.length = 0
    const acted = await client.runPromise(Devices.use((devices) => devices.act(clientThread, undefined, [touch])))
    expect(acted).toBe("done")
    expect(sent).toStrictEqual([{ deviceId: HUB_DEVICE, command: touch }])
  })

  test("linking a device hub does not make the client the hub's desktop", async () => {
    await expect(hub.runPromise(Peers.use((peers) => peers.ask("threads.list", undefined)))).rejects.toMatchObject({
      message: "This machine is not connected to any other HinaCode machine.",
    })
  })

  test("unlinking the hub returns the client to its own drivers", async () => {
    await client.runPromise(DeviceHub.use((deviceHub) => deviceHub.unlink))
    const settings = await client.runPromise(Settings.use((service) => service.get))
    expect(settings.experimental.deviceHub).toBeNull()
    expect(await client.runPromise(DeviceHub.use((deviceHub) => deviceHub.status))).toBeNull()
    expect((await listDevices()).ios).toStrictEqual({ kind: "missing", tool: "xcode" })
  })
})
