import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, layer } from "@effect/vitest"
import { NodeServices } from "@effect/platform-node"
import { Effect, Fiber, Layer } from "effect"
import { SqlClient } from "effect/sql"
import { TestClock } from "effect/testing"
import type { PushEvent } from "../../../shared/contract.ts"
import type { AgentAction, Device, DeviceCommand, DeviceId } from "../../../shared/device.ts"
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
const REMEMBERED_DEVICE: DeviceId = "ios:66666666-6666-6666-6666-666666666666"
const LANDSCAPE_DEVICE: DeviceId = "ios:77777777-7777-7777-7777-777777777777"
const CREATED_DEVICE: DeviceId = "ios:22222222-2222-2222-2222-222222222222"
const OTHER_CLIENTS_DEVICE: DeviceId = "ios:88888888-8888-8888-8888-888888888888"
let nextCreated = CREATED_DEVICE

const removed: Array<DeviceId> = []
let failingRemovals = 0
let removalsOfMissing = 0
let removalGate: Promise<void> | undefined
let removalStarted = false
const launched: Array<DeviceId> = []
const installed: Array<{ readonly id: DeviceId; readonly path: string; readonly plist: string }> = []
const published: Array<PushEvent> = []
const sent: Array<{ readonly deviceId: DeviceId; readonly command: DeviceCommand }> = []
const devices = new Map<DeviceId, Device>([
  [
    USERS_DEVICE,
    {
      id: USERS_DEVICE,
      platform: "ios",
      holders: [],
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
devices.set(REMEMBERED_DEVICE, { ...devices.get(USERS_DEVICE)!, id: REMEMBERED_DEVICE, name: "Remembered iPhone" })
devices.set(SPARE_DEVICE, { ...devices.get(USERS_DEVICE)!, id: SPARE_DEVICE, name: "Someone's spare iPhone" })

devices.set(LANDSCAPE_DEVICE, { ...devices.get(USERS_DEVICE)!, id: LANDSCAPE_DEVICE, name: "Sideways iPhone" })
devices.set(RACE_DEVICE, { ...devices.get(USERS_DEVICE)!, id: RACE_DEVICE, name: "Race fixture" })
const SOUND_DEVICE: DeviceId = "ios:99999999-9999-9999-9999-999999999999"
devices.set(SOUND_DEVICE, { ...devices.get(USERS_DEVICE)!, id: SOUND_DEVICE, name: "Loud iPhone" })

const sound = { play: (_pcm: Buffer) => {}, producers: 0, closed: 0 }
const SECOND_OF_PCM = 48_000 * 2 * 2
const heard = (chunks: ReadonlyArray<{ readonly data: string }>) =>
  chunks.map((chunk) => Buffer.from(chunk.data, "base64").toString())

const RIGHT_EDGE = { x: 1.5, y: 0.25, width: 0.5, height: 0.5 }

const ios: DevicePlatformDriver = {
  ...unavailableDriver({ kind: "ready" }),
  list: () => Promise.resolve([...devices.values()]),
  boot: () => Promise.resolve(),
  create: async (name, _model, _onStep, onCreated) => {
    const id = nextCreated
    nextCreated = CREATED_DEVICE
    devices.set(id, { ...devices.get(USERS_DEVICE)!, id, name })
    await onCreated(id)
    return id
  },
  remove: async (id) => {
    removalStarted = true
    await removalGate
    if (!devices.has(id)) {
      removalsOfMissing += 1
      return Promise.reject(new Error(`simslim: no simulator with udid ${id}`))
    }
    if (failingRemovals > 0) {
      failingRemovals -= 1
      return Promise.reject(new Error("simctl delete failed"))
    }
    removed.push(id)
    devices.delete(id)
    return Promise.resolve()
  },
  launch: (id) => Promise.resolve(void launched.push(id)),
  install: async (id, path) => {
    installed.push({ id, path, plist: await readFile(join(path, "Info.plist"), "utf8") })
    return "com.example.demo"
  },
  describe: () =>
    Promise.resolve([{ role: "button", label: "Right edge", identifier: "", value: "", frame: RIGHT_EDGE }]),
  audio: (_id, onPcm) => {
    sound.play = onPcm
    sound.producers += 1
    return Promise.resolve({
      rate: 48_000,
      channels: 2,
      ended: new Promise<string>(() => {}),
      close: () => Promise.resolve(void (sound.closed += 1)),
    })
  },
  connect: (id, onFrame) => {
    onFrame(
      id === LANDSCAPE_DEVICE
        ? { mime: "image/jpeg", data: Buffer.from("frame"), width: 4, height: 2, orientation: "landscape" }
        : { mime: "image/jpeg", data: Buffer.from("frame"), width: 2, height: 4, orientation: "portrait" },
    )
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
  uploadsDir: join(mkdtempSync(join(tmpdir(), "kk-devices-uploads-")), "uploads"),
}).pipe(
  Layer.provideMerge(settingsLayer(mkdtempSync(join(tmpdir(), "kk-devices-settings-")))),
  Layer.provide(Layer.succeed(Events, { publish: (event) => Effect.sync(() => void published.push(event)) })),
  Layer.provideMerge(Db.layer(":memory:")),
  Layer.provide(NodeServices.layer),
)

const archive = (threadId: string) =>
  SqlClient.SqlClient.use((sql) => sql`UPDATE thread SET status = 'archived' WHERE id = ${threadId}`)

const eventually = (check: () => boolean) =>
  Effect.gen(function* () {
    for (let turn = 0; turn < 1000 && !check(); turn++) yield* Effect.yieldNow
  })

const touch: DeviceCommand = { kind: "touch", phase: "down", x: 0.5, y: 0.5 }
const tap: AgentAction = { kind: "tap", x: 0.5, y: 0.5 }
const tapping = { steps: [[touch]] }

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

    it.effect("keeps the simulator another machine's thread created through the sweep", () =>
      Effect.gen(function* () {
        const service = yield* Devices
        const remoteThreadId = "7d0c4f7e-1d3b-4a51-9a39-3c3d2f6c9e10"
        removed.length = 0
        const created = yield* service.create(remoteThreadId, undefined, { id: "laptop-id", name: "laptop" })
        expect(created.phase).toBe("ready")

        yield* TestClock.adjust("6 seconds")
        yield* TestClock.adjust("6 seconds")
        expect(removed).toEqual([])
        expect((yield* service.get(remoteThreadId)).map((entry) => entry.phase)).toEqual(["ready"])
        const rows = yield* SqlClient.SqlClient.use(
          (sql) => sql`SELECT client_name FROM thread_device WHERE thread_id = ${remoteThreadId}`,
        )
        expect(rows).toEqual([{ clientName: "laptop" }])
        yield* service.detach(remoteThreadId, CREATED_DEVICE)
      }),
    )

    it.effect("releases one client's devices, deleting only the simulators its threads created", () =>
      Effect.gen(function* () {
        const service = yield* Devices
        const laptop = { id: "laptop-id", name: "laptop" }
        const desktop = { id: "desktop-id", name: "desktop" }
        const laptopCreating = "0b0c4f7e-1d3b-4a51-9a39-3c3d2f6c9e11"
        const laptopAttaching = "0b0c4f7e-1d3b-4a51-9a39-3c3d2f6c9e12"
        const desktopCreating = "0b0c4f7e-1d3b-4a51-9a39-3c3d2f6c9e13"
        removed.length = 0
        expect((yield* service.create(laptopCreating, undefined, laptop)).phase).toBe("ready")
        expect((yield* service.attach(laptopAttaching, USERS_DEVICE, laptop)).phase).toBe("ready")
        nextCreated = OTHER_CLIENTS_DEVICE
        expect((yield* service.create(desktopCreating, undefined, desktop)).phase).toBe("ready")

        const holders = (yield* service.list()).devices.find((device) => device.id === OTHER_CLIENTS_DEVICE)?.holders
        expect(holders?.map(({ client, clientId, threadId }) => ({ client, clientId, threadId }))).toEqual([
          { client: "desktop", clientId: desktop.id, threadId: desktopCreating },
        ])

        yield* service.release(laptop.id)
        expect(removed).toEqual([CREATED_DEVICE])
        expect(devices.has(USERS_DEVICE)).toBe(true)
        const rows = yield* SqlClient.SqlClient.use(
          (sql) => sql`SELECT thread_id, device_id FROM thread_device WHERE client_id IS NOT NULL`,
        )
        expect(rows).toEqual([{ threadId: desktopCreating, deviceId: OTHER_CLIENTS_DEVICE }])
        yield* service.release(desktop.id)
        expect(removed).toEqual([CREATED_DEVICE, OTHER_CLIENTS_DEVICE])
      }),
    )

    it.effect("forgets an archived thread's simulator that someone already deleted", () =>
      Effect.gen(function* () {
        const service = yield* Devices
        const { threadId } = yield* seedThread({ rootPath: "/tmp/kk-devices-gone" })
        expect((yield* service.create(threadId)).phase).toBe("ready")
        devices.delete(CREATED_DEVICE)
        yield* archive(threadId)

        yield* TestClock.adjust("6 seconds")
        yield* eventually(() => removalsOfMissing > 0)
        yield* TestClock.adjust("6 seconds")
        yield* TestClock.adjust("6 seconds")
        expect(removalsOfMissing).toBe(1)
        const rows = yield* SqlClient.SqlClient.use(
          (sql) => sql`SELECT device_id FROM thread_device WHERE thread_id = ${threadId}`,
        )
        expect(rows).toEqual([])
      }),
    )

    it.effect("holds the agent's input while the user has control and skips it on hand back", () =>
      Effect.gen(function* () {
        const service = yield* Devices
        const { threadId } = yield* seedThread({ rootPath: "/tmp/kk-devices-control" })
        yield* service.attach(threadId, USERS_DEVICE)
        yield* service.command({ threadId, deviceId: USERS_DEVICE, commands: [touch] })
        sent.length = 0

        const agent = yield* Effect.forkChild(service.act(threadId, undefined, tap, tapping))
        let [state] = yield* service.get(threadId)
        for (let turn = 0; turn < 1000 && !(state?.phase === "ready" && state.agentWaiting); turn++) {
          yield* Effect.yieldNow
          ;[state] = yield* service.get(threadId)
        }
        expect(state?.phase === "ready" && state.control === "user" && state.agentWaiting).toEqual(tap)

        yield* service.control(threadId, USERS_DEVICE, "agent")
        expect(yield* Fiber.join(agent)).toBe("handedBack")
        expect(sent).toEqual([])
      }),
    )

    it.effect("announces a swipe of many steps once, before its first touch", () =>
      Effect.gen(function* () {
        const service = yield* Devices
        const { threadId } = yield* seedThread({ rootPath: "/tmp/kk-devices-announce" })
        yield* service.attach(threadId, USERS_DEVICE)
        const swipe: AgentAction = { kind: "swipe", x: 0.5, y: 0.8, toX: 0.5, toY: 0.2, durationMs: 300 }
        const move: DeviceCommand = { kind: "touch", phase: "move", x: 0.5, y: 0.5 }
        published.length = 0
        sent.length = 0

        expect(yield* service.act(threadId, undefined, swipe, { steps: [[touch], [move], [touch]] })).toBe("done")
        const announced = () =>
          published.filter((event) => event.type === "device.agentAction" && event.threadId === threadId)
        yield* eventually(() => announced().length > 0)
        expect(announced()).toEqual([{ type: "device.agentAction", threadId, deviceId: USERS_DEVICE, action: swipe }])
        expect(sent).toHaveLength(3)
        yield* service.detach(threadId, USERS_DEVICE)
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

        const unnamed = yield* Effect.flip(service.act(threadId, undefined, tap, tapping))
        expect(unnamed.message).toContain("Someone's iPhone")
        expect(unnamed.message).toContain("Someone's iPad")

        yield* service.command({ threadId, deviceId: USERS_DEVICE, commands: [touch] })
        sent.length = 0
        expect(yield* service.act(threadId, "someone's ipad", tap, tapping)).toBe("done")
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
          service
            .act(second.threadId, undefined, tap, tapping)
            .pipe(Effect.tap((value) => Effect.sync(() => (outcome = value)))),
        )
        yield* eventually(() => outcome !== undefined || sent.length > 0)
        expect(sent).toEqual([])
        const [state] = yield* service.get(second.threadId)
        expect(state?.phase === "ready" && state.control === "user" && state.agentWaiting).toEqual(tap)
        const refused = yield* Effect.flip(service.control(second.threadId, USERS_DEVICE, "agent"))
        expect(refused.message).toContain("another thread")
        expect(sent).toEqual([])
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
          service
            .launch(threadId, undefined, "com.example.app")
            .pipe(Effect.tap(() => Effect.sync(() => (finished = true)))),
        )
        yield* eventually(() => finished || launched.length > 0)
        expect(launched).toEqual([])
        yield* service.control(threadId, USERS_DEVICE, "agent")
        expect(yield* Fiber.join(agent)).toBe("handedBack")
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

    it.effect("drives the device a thread had before a restart instead of creating one", () =>
      Effect.gen(function* () {
        const service = yield* Devices
        const { threadId } = yield* seedThread({ rootPath: "/tmp/kk-devices-restart" })
        yield* SqlClient.SqlClient.use(
          (sql) =>
            sql`INSERT INTO thread_device (thread_id, device_id, owned) VALUES (${threadId}, ${REMEMBERED_DEVICE}, 0)`,
        )
        sent.length = 0
        const created = devices.has(CREATED_DEVICE)

        expect(yield* service.act(threadId, undefined, tap, tapping)).toBe("done")
        expect(sent).toEqual([{ deviceId: REMEMBERED_DEVICE, command: touch }])
        expect(devices.has(CREATED_DEVICE)).toBe(created)
      }),
    )

    it.effect("measures taps and picks on a rotated device in the size it shows", () =>
      Effect.gen(function* () {
        const service = yield* Devices
        const { threadId } = yield* seedThread({ rootPath: "/tmp/kk-devices-landscape" })
        yield* service.attach(threadId, LANDSCAPE_DEVICE)

        expect((yield* service.screenshot(threadId, undefined)).screen).toEqual({ width: 2, height: 1 })
        const picked = yield* service.pick({ threadId, deviceId: LANDSCAPE_DEVICE, x: 0.9, y: 0.5 })
        expect(picked?.element.frame).toEqual(RIGHT_EDGE)
      }),
    )

    it.effect("streams sound in order, skips a late listener to the newest, and stops once nobody listens", () =>
      Effect.gen(function* () {
        const settings = yield* Settings
        yield* settings.set({ experimental: { ...(yield* settings.get).experimental, devices: true } })
        const service = yield* Devices
        while (!service.enabled()) yield* Effect.yieldNow
        const { threadId } = yield* seedThread({ rootPath: "/tmp/kk-devices-sound" })
        yield* service.attach(threadId, SOUND_DEVICE)
        const listen = (after: number) => service.audio({ threadId, deviceId: SOUND_DEVICE, after })

        const silence = yield* listen(-1)
        expect(silence).toEqual({ rate: 48_000, channels: 2, chunks: [] })
        expect(sound.producers).toBe(1)

        for (const note of ["do", "re", "mi"]) sound.play(Buffer.from(note))
        const song = yield* listen(0)
        expect(heard(song.chunks)).toEqual(["do", "re", "mi"])
        const sequences = song.chunks.map((chunk) => chunk.sequence)
        expect(sequences).toEqual(sequences.toSorted((a, b) => a - b))
        const caughtUp = sequences.at(-1)!

        for (const fill of ["x", "y", "z"]) sound.play(Buffer.alloc(SECOND_OF_PCM, fill))
        const late = yield* listen(caughtUp)
        expect(late.chunks.map((chunk) => Buffer.from(chunk.data, "base64")[0])).toEqual(["z".charCodeAt(0)])
        expect(late.chunks[0]!.sequence).toBe(caughtUp + 3)
        expect(sound.producers).toBe(1)

        yield* TestClock.adjust("6 seconds")
        expect(sound.closed).toBe(0)
        yield* TestClock.adjust("6 seconds")
        yield* eventually(() => sound.closed === 1)
        expect(sound.closed).toBe(1)
      }),
    )

    it.effect("leaves an archived thread's simulator alone while devices are off", () =>
      Effect.gen(function* () {
        const settings = yield* Settings
        const service = yield* Devices
        const setDevices = (on: boolean) =>
          Effect.gen(function* () {
            yield* settings.set({ experimental: { ...(yield* settings.get).experimental, devices: on } })
            while (service.enabled() !== on) yield* Effect.yieldNow
          })
        const { threadId } = yield* seedThread({ rootPath: "/tmp/kk-devices-off" })
        expect((yield* service.create(threadId)).phase).toBe("ready")
        removed.length = 0

        yield* setDevices(false)
        yield* archive(threadId)
        yield* TestClock.adjust("6 seconds")
        yield* Effect.yieldNow
        expect(removed).toEqual([])

        yield* setDevices(true)
        yield* TestClock.adjust("6 seconds")
        yield* eventually(() => removed.length > 0)
        expect(removed).toEqual([CREATED_DEVICE])
      }),
    )

    it.effect("installs an uploaded .app only when its chunks arrive in order and its hash matches", () =>
      Effect.gen(function* () {
        const service = yield* Devices
        const { threadId } = yield* seedThread({ rootPath: "/tmp/kk-devices-upload" })
        yield* service.attach(threadId, SECOND_DEVICE)
        const archive = demoAppArchive()
        const sha256 = createHash("sha256").update(archive).digest("hex")
        const half = Math.ceil(archive.length / 2)
        const chunks = [archive.subarray(0, half), archive.subarray(half)].map((part) => part.toString("base64"))
        const upload = Effect.gen(function* () {
          const { uploadId } = yield* service.uploadBegin({ threadId, kind: "app", bytes: archive.length })
          for (const [index, data] of chunks.entries()) yield* service.uploadChunk({ threadId, uploadId, index, data })
          return uploadId
        })
        installed.length = 0

        const tampered = yield* upload
        const wrongHash = yield* Effect.flip(
          service.uploadEnd({ threadId, uploadId: tampered, sha256: "0".repeat(64) }),
        )
        expect(wrongHash.message).toContain("SHA-256")

        const skipping = yield* service.uploadBegin({ threadId, kind: "app", bytes: archive.length })
        const outOfOrder = yield* Effect.flip(
          service.uploadChunk({ threadId, uploadId: skipping.uploadId, index: 1, data: chunks[1]! }),
        )
        expect(outOfOrder.message).toContain("Expected chunk 0")
        expect(installed).toEqual([])

        const uploadId = yield* upload
        expect(yield* service.uploadEnd({ threadId, uploadId, sha256 })).toEqual({
          device: "Someone's iPad",
          app: "com.example.demo",
        })
        expect(installed).toEqual([
          { id: SECOND_DEVICE, path: expect.stringMatching(/\/Demo\.app$/), plist: "<plist/>" },
        ])
        expect(existsSync(installed[0]!.path)).toBe(false)
        yield* service.detach(threadId, SECOND_DEVICE)
      }),
    )
  })
})

const demoAppArchive = () => {
  const dir = mkdtempSync(join(tmpdir(), "kk-devices-demo-app-"))
  mkdirSync(join(dir, "Demo.app"))
  writeFileSync(join(dir, "Demo.app", "Info.plist"), "<plist/>")
  execFileSync("tar", ["-cf", join(dir, "Demo.tar"), "-C", dir, "Demo.app"], {
    env: { ...process.env, COPYFILE_DISABLE: "1" },
  })
  return readFileSync(join(dir, "Demo.tar"))
}
