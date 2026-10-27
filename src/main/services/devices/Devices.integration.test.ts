import { describe, expect, layer } from "@effect/vitest"
import { NodeServices } from "@effect/platform-node"
import { Effect, Fiber, Layer } from "effect"
import { SqlClient } from "effect/sql"
import { TestClock } from "effect/testing"
import type { Device, DeviceCommand, DeviceId } from "../../../shared/device.ts"
import * as Db from "../../db/client.ts"
import { seedThread } from "../../db/testing.ts"
import { Events } from "../Events.ts"
import { Settings, layer as settingsLayer } from "../Settings.ts"
import { Devices, devicesLayer } from "./Devices.ts"
import type { DevicePlatformDriver } from "./platform.ts"
import { unavailableDriver } from "./unavailable.ts"

const USERS_DEVICE: DeviceId = "ios:11111111-1111-1111-1111-111111111111"
const CREATED_DEVICE: DeviceId = "ios:22222222-2222-2222-2222-222222222222"

const removed: Array<DeviceId> = []
const sent: Array<DeviceCommand> = []
const devices = new Map<DeviceId, Device>([
  [
    USERS_DEVICE,
    {
      id: USERS_DEVICE,
      platform: "ios",
      name: "Someone's iPhone",
      osVersion: "iOS 27.0",
      state: "booted",
      slim: null,
      memoryBytes: null,
      ownerThreadId: null,
    },
  ],
])

const ios: DevicePlatformDriver = {
  ...unavailableDriver({ kind: "ready" }),
  list: () => Promise.resolve([...devices.values()]),
  boot: () => Promise.resolve(),
  create: (name) => {
    devices.set(CREATED_DEVICE, { ...devices.get(USERS_DEVICE)!, id: CREATED_DEVICE, name })
    return Promise.resolve(CREATED_DEVICE)
  },
  remove: (id) => {
    removed.push(id)
    devices.delete(id)
    return Promise.resolve()
  },
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

const testLayer = devicesLayer({
  drivers: { ios, android: unavailableDriver({ kind: "missing", tool: "androidSdk" }) },
  simslimAvailable: () => Promise.resolve(true),
}).pipe(
  Layer.provideMerge(settingsLayer),
  Layer.provide(Layer.succeed(Events, { publish: () => Effect.void })),
  Layer.provideMerge(Db.layer(":memory:")),
  Layer.provide(NodeServices.layer),
)

const archive = (threadId: string) =>
  SqlClient.SqlClient.use((sql) => sql`UPDATE thread SET status = 'archived' WHERE id = ${threadId}`)

/** Yields until `check` holds, so the service's promise work can settle without a wall-clock wait. */
const eventually = (check: () => boolean) =>
  Effect.gen(function* () {
    for (let turn = 0; turn < 1000 && !check(); turn++) yield* Effect.yieldNow
  })

const touch: DeviceCommand = { kind: "touch", phase: "down", x: 0.5, y: 0.5 }

describe("Devices", () => {
  layer(testLayer)((it) => {
    it.effect("deletes only the simulator it created, and only once its thread is archived", () =>
      Effect.gen(function* () {
        const settings = yield* Settings
        yield* settings.set({ experimental: { ...(yield* settings.get).experimental, devices: true } })
        const service = yield* Devices
        while (!service.enabled()) yield* Effect.yieldNow
        const created = yield* seedThread({ rootPath: "/tmp/kk-devices-created" })
        const attached = yield* seedThread({ rootPath: "/tmp/kk-devices-attached" })

        expect((yield* service.create(created.threadId)).phase).toBe("ready")
        expect((yield* service.attach(attached.threadId, USERS_DEVICE)).phase).toBe("ready")
        yield* service.detach(attached.threadId)
        yield* TestClock.adjust("6 seconds")
        expect(removed).toEqual([])

        yield* service.attach(attached.threadId, USERS_DEVICE)
        yield* archive(attached.threadId)
        yield* archive(created.threadId)
        yield* TestClock.adjust("6 seconds")
        yield* eventually(() => removed.length > 0)
        expect(removed).toEqual([CREATED_DEVICE])
        expect(yield* service.get(created.threadId)).toEqual({ phase: "none" })
      }),
    )

    it.effect("holds the agent's input while the user has control and skips it on hand back", () =>
      Effect.gen(function* () {
        const service = yield* Devices
        const { threadId } = yield* seedThread({ rootPath: "/tmp/kk-devices-control" })
        yield* service.attach(threadId, USERS_DEVICE)
        yield* service.command({ threadId, commands: [touch] })
        sent.length = 0

        const agent = yield* Effect.forkChild(service.act(threadId, [touch]))
        let waiting = yield* service.get(threadId)
        for (let turn = 0; turn < 1000 && !(waiting.phase === "ready" && waiting.agentWaiting); turn++) {
          yield* Effect.yieldNow
          waiting = yield* service.get(threadId)
        }
        expect(waiting.phase === "ready" && waiting.control === "user" && waiting.agentWaiting).toBe(true)

        yield* service.control(threadId, "agent")
        expect(yield* Fiber.join(agent)).toBe("handedBack")
        expect(sent).toEqual([])
      }),
    )
  })
})
