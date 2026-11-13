import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, test } from "@effect/vitest"
import { vi } from "vitest"
import { Effect, Layer, ManagedRuntime, Stream } from "effect"
import { SqlClient } from "effect/sql"
import { unlistedModel } from "../../../shared/agent.ts"
import type { Device, DeviceCommand, DeviceId } from "../../../shared/device.ts"
import { pairingUrl } from "../../../shared/remote.ts"
import { ClaudeProvider } from "../../agents/claude/index.ts"
import { CodexProvider } from "../../agents/codex/index.ts"
import { MagpieProvider } from "../../agents/magpie/index.ts"
import { MuseProvider } from "../../agents/muse/index.ts"
import { OpencodeProvider } from "../../agents/opencode/index.ts"
import type { AgentProvider } from "../../agents/provider.ts"
import { seedThread } from "../../db/testing.ts"
import { RemoteAccess } from "../../remote/access.ts"
import { unusedLoopbackPort } from "../../remote/testing.ts"
import { dispatch } from "../../rpc.ts"
import { makeTestAppLayer } from "../../testing.ts"
import { Environments } from "../Environments.ts"
import { makeEventsLayer } from "../Events.ts"
import { Settings } from "../Settings.ts"
import { Devices } from "./Devices.ts"
import type { DevicePlatformDriver } from "./platform.ts"
import { unavailableDriver } from "./unavailable.ts"

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

const HUB_PIXEL: DeviceId = "android:Hub_Pixel"
const LAPTOP_PIXEL: DeviceId = "android:Laptop_Pixel"

const emulator = (id: DeviceId, name: string, sent: Array<DeviceCommand>): DevicePlatformDriver => {
  const device: Device = {
    id,
    platform: "android",
    name,
    osVersion: "Android 17",
    state: "booted",
    slim: null,
    memoryBytes: null,
    ownerThreadId: null,
  }
  return {
    ...unavailableDriver({ kind: "ready" }),
    list: () => Promise.resolve([device]),
    boot: () => Promise.resolve(),
    connect: (_id, onFrame) => {
      onFrame({ mime: "image/jpeg", data: Buffer.from("frame"), width: 2, height: 4, orientation: "portrait" })
      return Promise.resolve({
        screen: { width: 1, height: 2, scale: 2 },
        send: (commands) => Promise.resolve(void sent.push(...commands)),
        ended: new Promise<string>(() => {}),
        close: () => Promise.resolve(),
      })
    },
  }
}

const hubSent: Array<DeviceCommand> = []
const laptopSent: Array<DeviceCommand> = []

const app = (dbPath: string, id: DeviceId, name: string, sent: Array<DeviceCommand>) =>
  makeTestAppLayer(dbPath, {
    providers,
    events: makeEventsLayer(() => {}),
    devices: {
      drivers: { ios: unavailableDriver({ kind: "missing", tool: "xcode" }), android: emulator(id, name, sent) },
      simslimAvailable: () => Promise.resolve(false),
    },
  })

const makeHub = (dbPath: string) => app(dbPath, HUB_PIXEL, "Hub Pixel", hubSent)
const makeLaptop = (dbPath: string) => app(dbPath, LAPTOP_PIXEL, "Laptop Pixel", laptopSent)

let dir = ""
let hubId = ""
let threadId = ""
let hub: ManagedRuntime.ManagedRuntime<Layer.Success<ReturnType<typeof makeHub>>, unknown>
let laptop: ManagedRuntime.ManagedRuntime<Layer.Success<ReturnType<typeof makeLaptop>>, unknown>

const setDevices = (runtime: typeof hub, devicesHub: string | null) =>
  runtime.runPromise(
    Settings.use((settings) =>
      Effect.gen(function* () {
        yield* settings.set({ experimental: { ...(yield* settings.get).experimental, devices: true, devicesHub } })
      }),
    ),
  )

const hubRows = () =>
  hub.runPromise(
    SqlClient.SqlClient.use(
      (sql) =>
        sql<{
          deviceId: string
          guest: number
        }>`SELECT device_id, guest FROM thread_device WHERE thread_id = ${threadId}`,
    ),
  )

const listed = () =>
  laptop.runPromise(
    Devices.use((devices) => devices.list({ threadId })).pipe(
      Effect.map((host) => host.devices.map((each) => each.id)),
    ),
  )

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "kk-device-hub-"))
  mkdirSync(join(dir, "hub"))
  mkdirSync(join(dir, "laptop"))
  hub = ManagedRuntime.make(makeHub(join(dir, "hub", "hinacode.sqlite")))
  laptop = ManagedRuntime.make(makeLaptop(join(dir, "laptop", "hinacode.sqlite")))
  const port = await unusedLoopbackPort()
  await hub.runPromise(
    Settings.use((settings) => settings.set({ remote: { enabled: true, bindHost: "127.0.0.1", port } })),
  )
  await setDevices(hub, null)
  await setDevices(laptop, null)
  await vi.waitFor(
    async () => expect((await hub.runPromise(RemoteAccess.use((remote) => remote.status))).listening).toBe(true),
    { timeout: 10_000 },
  )
  const pairing = await hub.runPromise(RemoteAccess.use((remote) => remote.pairing))
  const environment = await laptop.runPromise(
    Environments.use((environments) =>
      environments.add({
        name: "Hub",
        pairingUrl: pairingUrl({ hosts: ["127.0.0.1"], port: pairing.port, token: pairing.token, relay: null }),
      }),
    ),
  )
  hubId = environment.id
  await vi.waitFor(
    async () => {
      const { clouds } = await laptop.runPromise(Environments.use((environments) => environments.list))
      expect(clouds.find((cloud) => cloud.id === hubId)?.status).toBe("connected")
    },
    { timeout: 10_000 },
  )
  threadId = (await laptop.runPromise(seedThread({ rootPath: join(dir, "laptop-repo") }))).threadId
})

afterAll(async () => {
  await laptop.dispose()
  await hub.dispose()
  rmSync(dir, { recursive: true, force: true })
})

describe("device hub", () => {
  test("runs on this machine until a hub is set, then drives the hub's devices as a guest", async () => {
    expect(await listed()).toEqual([LAPTOP_PIXEL])

    await setDevices(laptop, hubId)
    await vi.waitFor(async () => expect(await listed()).toEqual([HUB_PIXEL]))

    const attached = await laptop.runPromise(Devices.use((devices) => devices.attach(threadId, HUB_PIXEL)))
    expect(attached.phase).toBe("ready")
    expect(await hubRows()).toEqual([{ deviceId: HUB_PIXEL, guest: 1 }])

    const shot = await laptop.runPromise(Devices.use((devices) => devices.screenshot(threadId, undefined)))
    expect(shot.state.device.id).toBe(HUB_PIXEL)
    expect(shot.screen).toEqual({ width: 1, height: 2 })

    const touch: DeviceCommand = { kind: "touch", phase: "down", x: 0.5, y: 0.5 }
    const outcome = await laptop.runPromise(
      Devices.use((devices) => devices.act(threadId, undefined, { kind: "tap", x: 0.5, y: 0.5 }, { steps: [[touch]] })),
    )
    expect(outcome).toBe("done")
    expect(hubSent).toEqual([touch])
    expect(laptopSent).toEqual([])
  })

  test("answers a guest's calls on the hub even when the hub's own Device hub is the laptop", async () => {
    const port = await unusedLoopbackPort()
    await laptop.runPromise(
      Settings.use((settings) => settings.set({ remote: { enabled: true, bindHost: "127.0.0.1", port } })),
    )
    await vi.waitFor(
      async () => expect((await laptop.runPromise(RemoteAccess.use((remote) => remote.status))).listening).toBe(true),
      { timeout: 10_000 },
    )
    const pairing = await laptop.runPromise(RemoteAccess.use((remote) => remote.pairing))
    const back = await hub.runPromise(
      Environments.use((environments) =>
        environments.add({
          name: "Laptop",
          pairingUrl: pairingUrl({ hosts: ["127.0.0.1"], port: pairing.port, token: pairing.token, relay: null }),
        }),
      ),
    )
    await vi.waitFor(
      async () => {
        const { clouds } = await hub.runPromise(Environments.use((environments) => environments.list))
        expect(clouds.find((cloud) => cloud.id === back.id)?.status).toBe("connected")
      },
      { timeout: 10_000 },
    )
    await setDevices(hub, back.id)

    expect(await listed()).toEqual([HUB_PIXEL])
  })

  test("releases the guest thread's devices on the hub when the thread is archived after switching back", async () => {
    await setDevices(laptop, null)
    expect(await hubRows()).toEqual([{ deviceId: HUB_PIXEL, guest: 1 }])
    const archived = await laptop.runPromise(dispatch({ method: "threads.archive", payload: { threadId } }, null))
    expect("result" in archived).toBe(true)
    await vi.waitFor(async () => expect(await hubRows()).toEqual([]), { timeout: 5_000 })
  })

  test("falls back to this machine when the hub is no longer paired", async () => {
    await setDevices(laptop, "removed-environment")
    await vi.waitFor(async () => expect(await listed()).toEqual([LAPTOP_PIXEL]))
  })
})
