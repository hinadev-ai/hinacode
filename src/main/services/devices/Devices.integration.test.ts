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
const SECOND_DEVICE: DeviceId = "ios:33333333-3333-3333-3333-333333333333"
const SPARE_DEVICE: DeviceId = "ios:44444444-4444-4444-4444-444444444444"
const RACE_DEVICE: DeviceId = "ios:55555555-5555-5555-5555-555555555555"
const CREATED_DEVICE: DeviceId = "ios:22222222-2222-2222-2222-222222222222"

const removed: Array<DeviceId> = []
let failingRemovals = 0
let removalGate: Promise<void> | undefined
let removalStarted = false
const launched: Array<DeviceId> = []
const sent: Array<{ readonly deviceId: DeviceId; readonly command: DeviceCommand }> = []
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
devices.set(SECOND_DEVICE, { ...devices.get(USERS_DEVICE)!, id: SECOND_DEVICE, name: "Someone's iPad" })
devices.set(SPARE_DEVICE, { ...devices.get(USERS_DEVICE)!, id: SPARE_DEVICE, name: "Someone's spare iPhone" })

devices.set(RACE_DEVICE, { ...devices.get(USERS_DEVICE)!, id: RACE_DEVICE, name: "Race fixture" })

const ios: DevicePlatformDriver = {
  ...unavailableDriver({ kind: "ready" }),
  list: () => Promise.resolve([...devices.values()]),
  boot: () => Promise.resolve(),
  create: async (name, _onStep, onCreated) => {
    devices.set(CREATED_DEVICE, { ...devices.get(USERS_DEVICE)!, id: CREATED_DEVICE, name })
    await onCreated(CREATED_DEVICE)
    return CREATED_DEVICE
  },
  remove: async (id) => {
    removalStarted = true
    await removalGate
    if (failingRemovals > 0) {
      failingRemovals -= 1
      return Promise.reject(new Error("simctl delete failed"))
    }
    removed.push(id)
    devices.delete(id)
    return Promise.resolve()
  },
  launch: (id) => Promise.resolve(void launched.push(id)),
  connect: (id, onFrame) => {
    onFrame({ mime: "image/jpeg", data: Buffer.from("frame"), width: 2, height: 4, orientation: "portrait" })
    return Promise.resolve({
      screen: { width: 1, height: 2, scale: 2 },
      send: (commands) => Promise.resolve(void sent.push(...commands.map((command) => ({ deviceId: id, command })))),
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
        yield* service.detach(attached.threadId, USERS_DEVICE)
        yield* TestClock.adjust("6 seconds")
        expect(removed).toEqual([])

        yield* service.attach(attached.threadId, USERS_DEVICE)
        yield* archive(attached.threadId)
        yield* archive(created.threadId)
        yield* TestClock.adjust("6 seconds")
        yield* eventually(() => removed.length > 0)
        expect(removed).toEqual([CREATED_DEVICE])
        expect(yield* service.get(created.threadId)).toEqual([])
      }),
    )

    it.effect("deletes a deleted thread's simulator, retrying a removal that failed", () =>
      Effect.gen(function* () {
        const service = yield* Devices
        const { threadId } = yield* seedThread({ rootPath: "/tmp/kk-devices-deleted" })
        expect((yield* service.create(threadId)).phase).toBe("ready")
        removed.length = 0
        failingRemovals = 1
        yield* SqlClient.SqlClient.use((sql) => sql`DELETE FROM thread WHERE id = ${threadId}`)

        yield* TestClock.adjust("6 seconds")
        yield* eventually(() => failingRemovals === 0)
        expect(removed).toEqual([])
        yield* TestClock.adjust("6 seconds")
        yield* eventually(() => removed.length > 0)
        expect(removed).toEqual([CREATED_DEVICE])
      }),
    )

    it.effect("holds the agent's input while the user has control and skips it on hand back", () =>
      Effect.gen(function* () {
        const service = yield* Devices
        const { threadId } = yield* seedThread({ rootPath: "/tmp/kk-devices-control" })
        yield* service.attach(threadId, USERS_DEVICE)
        yield* service.command({ threadId, deviceId: USERS_DEVICE, commands: [touch] })
        sent.length = 0

        const agent = yield* Effect.forkChild(service.act(threadId, undefined, [touch]))
        let [state] = yield* service.get(threadId)
        for (let turn = 0; turn < 1000 && !(state?.phase === "ready" && state.agentWaiting); turn++) {
          yield* Effect.yieldNow
          ;[state] = yield* service.get(threadId)
        }
        expect(state?.phase === "ready" && state.control === "user" && state.agentWaiting).toBe(true)

        yield* service.control(threadId, USERS_DEVICE, "agent")
        expect(yield* Fiber.join(agent)).toBe("handedBack")
        expect(sent).toEqual([])
      }),
    )

    it.effect("makes the agent name a device once the thread has two, and holds only the one the user took", () =>
      Effect.gen(function* () {
        const service = yield* Devices
        const { threadId } = yield* seedThread({ rootPath: "/tmp/kk-devices-two" })
        yield* service.attach(threadId, USERS_DEVICE)
        yield* service.attach(threadId, SECOND_DEVICE)
        expect((yield* service.get(threadId)).map((state) => state.phase === "ready" && state.device.id)).toEqual([
          USERS_DEVICE,
          SECOND_DEVICE,
        ])

        const unnamed = yield* Effect.flip(service.act(threadId, undefined, [touch]))
        expect(unnamed.message).toContain("Someone's iPhone")
        expect(unnamed.message).toContain("Someone's iPad")

        yield* service.command({ threadId, deviceId: USERS_DEVICE, commands: [touch] })
        sent.length = 0
        expect(yield* service.act(threadId, "someone's ipad", [touch])).toBe("done")
        expect(sent).toEqual([{ deviceId: SECOND_DEVICE, command: touch }])
      }),
    )

    it.effect("holds every thread's agent input while a shared device is under user control", () =>
      Effect.gen(function* () {
        const service = yield* Devices
        const first = yield* seedThread({ rootPath: "/tmp/kk-devices-shared-first" })
        const second = yield* seedThread({ rootPath: "/tmp/kk-devices-shared-second" })
        yield* service.attach(first.threadId, USERS_DEVICE)
        yield* service.attach(second.threadId, USERS_DEVICE)
        yield* service.command({ threadId: first.threadId, deviceId: USERS_DEVICE, commands: [touch] })
        sent.length = 0
        let outcome: string | undefined
        const agent = yield* Effect.forkChild(
          service.act(second.threadId, undefined, [touch]).pipe(Effect.tap((value) => Effect.sync(() => (outcome = value)))),
        )
        yield* eventually(() => outcome !== undefined || sent.length > 0)
        expect(sent).toEqual([])
        const [state] = yield* service.get(second.threadId)
        expect(state?.phase === "ready" && state.control === "user" && state.agentWaiting).toBe(true)
        yield* service.control(first.threadId, USERS_DEVICE, "agent")
        expect(yield* Fiber.join(agent)).toBe("handedBack")
        yield* service.detach(first.threadId, USERS_DEVICE)
        yield* service.detach(second.threadId, USERS_DEVICE)
      }),
    )

    it.effect("holds an app launch while the user has control and skips it on hand back", () =>
      Effect.gen(function* () {
        const service = yield* Devices
        const { threadId } = yield* seedThread({ rootPath: "/tmp/kk-devices-launch" })
        yield* service.attach(threadId, USERS_DEVICE)
        yield* service.command({ threadId, deviceId: USERS_DEVICE, commands: [touch] })
        launched.length = 0
        let finished = false
        const agent = yield* Effect.forkChild(
          service.launch(threadId, undefined, "com.example.app").pipe(Effect.tap(() => Effect.sync(() => (finished = true)))),
        )
        yield* eventually(() => finished || launched.length > 0)
        expect(launched).toEqual([])
        yield* service.control(threadId, USERS_DEVICE, "agent")
        yield* Fiber.join(agent)
        expect(launched).toEqual([])
        yield* service.detach(threadId, USERS_DEVICE)
      }),
    )

    it.effect("refuses an attach while deletion is in progress", () =>
      Effect.gen(function* () {
        const service = yield* Devices
        const deleting = yield* seedThread({ rootPath: "/tmp/kk-devices-delete-race" })
        const attaching = yield* seedThread({ rootPath: "/tmp/kk-devices-attach-race" })
        const gate = Promise.withResolvers<void>()
        removalGate = gate.promise
        removalStarted = false
        const deletion = yield* Effect.forkChild(service.delete(deleting.threadId, RACE_DEVICE))
        yield* eventually(() => removalStarted)
        expect(removalStarted).toBe(true)
        try {
          const result = yield* Effect.result(service.attach(attaching.threadId, RACE_DEVICE))
          expect(result._tag).toBe("Failure")
          expect(yield* service.get(attaching.threadId)).toEqual([])
        } finally {
          gate.resolve()
          removalGate = undefined
        }
        yield* Fiber.join(deletion)
      }),
    )

    it.effect("deletes the user's own device on request, but not while another thread has it attached", () =>
      Effect.gen(function* () {
        const service = yield* Devices
        const using = yield* seedThread({ rootPath: "/tmp/kk-devices-using" })
        const deleting = yield* seedThread({ rootPath: "/tmp/kk-devices-deleting" })
        yield* service.attach(using.threadId, SPARE_DEVICE)
        removed.length = 0

        const refused = yield* Effect.flip(service.delete(deleting.threadId, SPARE_DEVICE))
        expect(refused.message).toContain("Another thread")
        expect(removed).toEqual([])

        yield* service.detach(using.threadId, SPARE_DEVICE)
        yield* service.delete(deleting.threadId, SPARE_DEVICE)
        expect(removed).toEqual([SPARE_DEVICE])
      }),
    )
  })
})
