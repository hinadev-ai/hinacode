import { execFile } from "node:child_process"
import { createHash, type Hash, randomUUID } from "node:crypto"
import { appendFile, mkdir, readdir, rm, stat } from "node:fs/promises"
import { join } from "node:path"
import { promisify } from "node:util"
import { Clock, Context, Effect, Layer, Schedule, Schema, Stream } from "effect"
import { SqlClient } from "effect/sql"
import type { RpcRequest, RpcResponse } from "../../../shared/contract.ts"
import {
  type AgentAction,
  type AudioChunk,
  type DeviceAudio,
  type DeviceCheck,
  type DeviceClient,
  type Requirement,
  devicePlatformOf,
  type Device,
  type DeviceCommand,
  type DeviceControl,
  type DeviceElement,
  type DeviceFrame,
  type DeviceHost,
  type DeviceId,
  type DevicePlatform,
  type InstallKind,
  type PickedDeviceElement,
  type PrepareStep,
  requirementPlatform,
  shownScreen,
  type SimulatorModelId,
  threadDeviceId,
  type ThreadDevice,
  type ThreadDevices,
} from "../../../shared/device.ts"
import { Events } from "../Events.ts"
import { Settings } from "../Settings.ts"
import type { AudioLink, DeviceLink, DevicePlatformDriver, Frame } from "./platform.ts"

class DevicesError extends Schema.TaggedError<DevicesError>()("DevicesError", { message: Schema.String }) {}

type AgentInput = "done" | "handedBack"

export type ReadyDevice = Extract<ThreadDevice, { phase: "ready" }>

export interface AgentSteps {
  readonly steps: ReadonlyArray<ReadonlyArray<DeviceCommand>>
  readonly gapMs?: number
  readonly release?: ReadonlyArray<DeviceCommand>
}

export class Devices extends Context.Service<
  Devices,
  {
    readonly enabled: () => boolean
    readonly list: () => Effect.Effect<DeviceHost, DevicesError>
    readonly get: (threadId: string) => Effect.Effect<ThreadDevices, DevicesError>
    readonly attach: (
      threadId: string,
      deviceId: DeviceId,
      client?: DeviceClient,
    ) => Effect.Effect<ThreadDevice, DevicesError>
    readonly create: (
      threadId: string,
      model?: SimulatorModelId,
      client?: DeviceClient,
    ) => Effect.Effect<ThreadDevice, DevicesError>
    readonly detach: (threadId: string, deviceId: DeviceId | null) => Effect.Effect<void, DevicesError>
    readonly delete: (threadId: string, deviceId: DeviceId) => Effect.Effect<void, DevicesError>
    readonly shutdown: (deviceId: DeviceId) => Effect.Effect<void, DevicesError>
    readonly frame: (input: RpcRequest<"device.frame">) => Effect.Effect<{ frame: DeviceFrame | null }, DevicesError>
    readonly command: (input: RpcRequest<"device.command">) => Effect.Effect<void, DevicesError>
    readonly control: (
      threadId: string,
      deviceId: DeviceId,
      control: DeviceControl,
    ) => Effect.Effect<ThreadDevice, DevicesError>
    readonly pick: (input: RpcRequest<"device.pick">) => Effect.Effect<PickedDeviceElement | null, DevicesError>
    readonly act: (
      threadId: string,
      device: string | undefined,
      action: AgentAction,
      input: AgentSteps,
      client?: DeviceClient,
    ) => Effect.Effect<AgentInput, DevicesError>
    readonly screenshot: (
      threadId: string,
      device: string | undefined,
      client?: DeviceClient,
    ) => Effect.Effect<
      { readonly frame: DeviceFrame; readonly state: ReadyDevice; readonly screen: ReturnType<typeof shownScreen> },
      DevicesError
    >
    readonly describe: (
      threadId: string,
      device: string | undefined,
      client?: DeviceClient,
    ) => Effect.Effect<ReadonlyArray<DeviceElement>, DevicesError>
    readonly launch: (
      threadId: string,
      device: string | undefined,
      app: string,
      client?: DeviceClient,
    ) => Effect.Effect<AgentInput, DevicesError>
    readonly claim: (input: RpcRequest<"devices.claim">) => Effect.Effect<void, DevicesError>
    readonly release: (clientId: string) => Effect.Effect<void, DevicesError>
    readonly setup: (requirement: Requirement) => Effect.Effect<DeviceHost, DevicesError>
    readonly checks: () => Effect.Effect<ReadonlyArray<DeviceCheck>, DevicesError>
    readonly logs: (input: RpcRequest<"device.logs">) => Effect.Effect<RpcResponse<"device.logs">, DevicesError>
    readonly install: (
      threadId: string,
      device: string | undefined,
      path: string,
    ) => Effect.Effect<RpcResponse<"device.install.end">, DevicesError>
    readonly uploadBegin: (
      input: RpcRequest<"device.install.begin">,
    ) => Effect.Effect<RpcResponse<"device.install.begin">, DevicesError>
    readonly uploadChunk: (input: RpcRequest<"device.install.chunk">) => Effect.Effect<void, DevicesError>
    readonly uploadEnd: (
      input: RpcRequest<"device.install.end">,
    ) => Effect.Effect<RpcResponse<"device.install.end">, DevicesError>
    readonly audio: (input: RpcRequest<"device.audio">) => Effect.Effect<DeviceAudio, DevicesError>
  }
>()("hinacode/Devices") {}

interface DevicesOptions {
  readonly drivers: Record<DevicePlatform, DevicePlatformDriver>
  readonly uploadsDir: string
  readonly leaseMs?: number
}

interface Upload {
  readonly threadId: string
  readonly deviceId: DeviceId
  readonly kind: InstallKind
  readonly bytes: number
  readonly path: string
  readonly hash: Hash
  received: number
  nextIndex: number
  touchedAt: number
  written: Promise<void>
}

const UPLOAD_IDLE_MS = 60_000
const platformOfKind: Record<InstallKind, DevicePlatform> = { app: "ios", apk: "android" }
const execFileAsync = promisify(execFile)

const installKindOf = async (path: string): Promise<InstallKind> => {
  const info = await stat(path).catch(() => null)
  if (info?.isFile() && path.endsWith(".apk")) return "apk"
  if (info?.isDirectory() && path.replace(/\/+$/, "").endsWith(".app")) return "app"
  throw new DevicesError({ message: "Install an iOS .app directory or an Android .apk file that exists." })
}

const unpackApp = async (archive: string, into: string) => {
  await mkdir(into)
  await execFileAsync("tar", ["-xf", archive, "-C", into, "--no-same-owner"], { timeout: 5 * 60_000 })
  const entries = await readdir(into, { withFileTypes: true })
  const [app] = entries
  if (entries.length !== 1 || !app?.isDirectory() || !app.name.endsWith(".app")) {
    throw new DevicesError({ message: "The upload must hold exactly one .app directory at its top level." })
  }
  return join(into, app.name)
}

interface Screen {
  latest: DeviceFrame | null
  readonly waiters: Set<() => void>
  closed: boolean
}

interface Live extends Screen {
  readonly deviceId: DeviceId
  readonly link: Promise<DeviceLink>
  lease: number
}

interface Sound {
  readonly deviceId: DeviceId
  readonly link: Promise<AudioLink>
  readonly ring: Array<AudioChunk & { readonly bytes: number }>
  readonly waiters: Set<() => void>
  ringBytes: number
  trimmedThrough: number
  heardAt: number
  closed: boolean
}

interface Row {
  readonly deviceId: DeviceId
  readonly owned: boolean
}

const NEW = "new"
type Slot = DeviceId | typeof NEW
const slotOf = (entry: ThreadDevice): Slot => threadDeviceId(entry) ?? NEW
const keyOf = (threadId: string, slot: Slot) => `${threadId}\n${slot}`
const describeDevice = (state: ReadyDevice) => `${state.device.name} (${state.device.id})`
const FRAME_WAIT_MS = 1000
const AUDIO_WAIT_MS = 1000
const AUDIO_RING_BYTES = 2 * 48_000 * 2 * 2
const AUDIO_LEASE_MS = 10_000
const messageOf = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause))
const failure = (cause: unknown) =>
  cause instanceof DevicesError ? cause : new DevicesError({ message: messageOf(cause) })

const make = (options: DevicesOptions) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const events = yield* Events
    const settings = yield* Settings
    const drivers: Record<DevicePlatform, DevicePlatformDriver> = options.drivers
    const scope = yield* Effect.scope
    const runFork = Effect.runForkWith(yield* Effect.context<never>())

    let enabled = yield* settings.get.pipe(
      Effect.map((value) => value.experimental.devices),
      Effect.orElseSucceed(() => false),
    )
    const states = new Map<string, Map<Slot, ThreadDevice>>()
    const links = new Map<DeviceId, Live>()
    let frameSequence = 0
    const sounds = new Map<DeviceId, Sound>()
    let audioSequence = 0
    const preparing = new Map<string, Promise<ThreadDevice>>()
    const handBacks = new Map<string, Set<() => void>>()
    const waiting = new Map<string, ReadonlyArray<AgentAction>>()
    const userControl = new Map<DeviceId, string>()
    const deleting = new Set<DeviceId>()
    const attaching = new Map<DeviceId, number>()
    const uploads = new Map<string, Upload>()
    yield* Effect.promise(() => rm(options.uploadsDir, { recursive: true, force: true }))

    const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)

    const readRows = (threadId: string) =>
      run(
        sql<{
          deviceId: DeviceId
          owned: number
        }>`SELECT device_id, owned FROM thread_device WHERE thread_id = ${threadId} ORDER BY rowid`.pipe(
          Effect.map((rows) => rows.map((row): Row => ({ deviceId: row.deviceId, owned: row.owned === 1 }))),
        ),
      )
    const readRow = async (threadId: string, deviceId: DeviceId) =>
      (await readRows(threadId)).find((row) => row.deviceId === deviceId) ?? null
    const writeRow = (threadId: string, row: Row, client: DeviceClient | null) =>
      run(
        sql`INSERT INTO thread_device (thread_id, device_id, owned, client_id, client_name, claimed_at)
            VALUES (${threadId}, ${row.deviceId}, ${row.owned ? 1 : 0}, ${client?.id ?? null}, ${client?.name ?? null}, ${client ? Date.now() : null})
            ON CONFLICT (thread_id, device_id) DO NOTHING`,
      )
    const deleteRow = (threadId: string, deviceId: DeviceId) =>
      run(sql`DELETE FROM thread_device WHERE thread_id = ${threadId} AND device_id = ${deviceId}`)
    const ownedRows = () =>
      run(sql<{ threadId: string; deviceId: string }>`SELECT thread_id, device_id FROM thread_device WHERE owned = 1`)

    const driverOf = (deviceId: DeviceId) => drivers[devicePlatformOf(deviceId)]

    const listOf = (threadId: string): ThreadDevices => [...(states.get(threadId)?.values() ?? [])]
    const current = (threadId: string, slot: Slot) => states.get(threadId)?.get(slot) ?? null

    const releaseHandBacks = (key: string) => {
      const resolvers = handBacks.get(key)
      handBacks.delete(key)
      resolvers?.forEach((resolve) => resolve())
    }

    const publish = (threadId: string) =>
      runFork(events.publish({ type: "device.updated", threadId, devices: listOf(threadId) }))

    const setState = (threadId: string, state: ThreadDevice, from: Slot = slotOf(state)) => {
      const slot = slotOf(state)
      const previous = states.get(threadId) ?? new Map<Slot, ThreadDevice>()
      const next = new Map<Slot, ThreadDevice>()
      for (const [each, entry] of previous) next.set(each === from ? slot : each, each === from ? state : entry)
      if (!next.has(slot)) next.set(slot, state)
      states.set(threadId, next)
      if (!(state.phase === "ready" && state.control === "user")) releaseHandBacks(keyOf(threadId, slot))
      publish(threadId)
      return state
    }

    const removeState = (threadId: string, slot: Slot) => {
      if (slot !== NEW && userControl.get(slot) === threadId) setControl(threadId, slot, "agent")
      const entries = states.get(threadId)
      entries?.delete(slot)
      if (entries?.size === 0) states.delete(threadId)
      releaseHandBacks(keyOf(threadId, slot))
      publish(threadId)
    }

    const controlOf = (deviceId: DeviceId): DeviceControl => (userControl.has(deviceId) ? "user" : "agent")

    const waitingOn = (deviceId: DeviceId) =>
      [...states.keys()].flatMap((threadId) => waiting.get(keyOf(threadId, deviceId)) ?? []).at(-1) ?? null

    const announce = (deviceId: DeviceId, action: AgentAction) => {
      for (const [threadId, entries] of states) {
        if (entries.get(deviceId)?.phase !== "ready") continue
        runFork(events.publish({ type: "device.agentAction", threadId, deviceId, action }))
      }
    }

    const findDevice = async (deviceId: DeviceId): Promise<Device> => {
      const device = (await driverOf(deviceId).list()).find((candidate) => candidate.id === deviceId)
      if (!device) throw new DevicesError({ message: "This device no longer exists on the machine." })
      return device
    }

    const closeLive = (live: Live) => {
      if (live.closed) return
      live.closed = true
      links.delete(live.deviceId)
      live.waiters.forEach((wake) => wake())
      void live.link.then((link) => link.close()).catch(() => undefined)
    }

    const closeSound = (sound: Sound) => {
      if (sound.closed) return
      sound.closed = true
      if (sounds.get(sound.deviceId) === sound) sounds.delete(sound.deviceId)
      sound.waiters.forEach((wake) => wake())
      void sound.link.then((link) => link.close()).catch(() => undefined)
    }

    const listen = (deviceId: DeviceId) => {
      const existing = sounds.get(deviceId)
      if (existing) return existing
      const heard = {
        deviceId,
        ring: [] as Sound["ring"],
        waiters: new Set<() => void>(),
        ringBytes: 0,
        trimmedThrough: audioSequence,
        heardAt: 0,
        closed: false,
      }
      const onPcm = (pcm: Buffer) => {
        if (heard.closed || pcm.length === 0) return
        heard.ring.push({ sequence: ++audioSequence, data: pcm.toString("base64"), bytes: pcm.length })
        heard.ringBytes += pcm.length
        while (heard.ringBytes > AUDIO_RING_BYTES && heard.ring.length > 1) {
          const dropped = heard.ring.shift()!
          heard.ringBytes -= dropped.bytes
          heard.trimmedThrough = dropped.sequence
        }
        const waiters = [...heard.waiters]
        heard.waiters.clear()
        waiters.forEach((wake) => wake())
      }
      const sound: Sound = Object.assign(heard, { link: driverOf(deviceId).audio(deviceId, onPcm) })
      sounds.set(deviceId, sound)
      void sound.link.then(
        (link) => link.ended.then(() => closeSound(sound)),
        () => closeSound(sound),
      )
      return sound
    }

    const chunksAfter = (sound: Sound, after: number): ReadonlyArray<AudioChunk> => {
      const newer = sound.ring.filter((chunk) => chunk.sequence > after)
      const fellBehind = after < sound.trimmedThrough
      return (fellBehind ? newer.slice(-1) : newer).map(({ sequence, data }) => ({ sequence, data }))
    }

    const nextChunks = async (sound: Sound, after: number) => {
      if ((sound.ring.at(-1)?.sequence ?? 0) > after) return chunksAfter(sound, after)
      if (sound.closed) return []
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          sound.waiters.delete(wake)
          resolve()
        }, AUDIO_WAIT_MS)
        const wake = () => {
          clearTimeout(timer)
          resolve()
        }
        sound.waiters.add(wake)
      })
      return chunksAfter(sound, after)
    }

    const failThreadsOn = (deviceId: DeviceId, message: string) => {
      userControl.delete(deviceId)
      for (const [threadId, entries] of states) {
        const entry = entries.get(deviceId)
        if (entry?.phase === "ready") {
          const owned = entry.device.ownerThreadId === threadId
          setState(threadId, { phase: "failed", deviceId, name: entry.device.name, owned, message })
        }
      }
    }

    const connect = (deviceId: DeviceId) => {
      const existing = links.get(deviceId)
      if (existing) {
        existing.lease = Date.now()
        return existing
      }
      const screen: Screen = { latest: null, waiters: new Set(), closed: false }
      const onFrame = (frame: Frame) => {
        if (screen.closed) return
        screen.latest = {
          sequence: ++frameSequence,
          mime: frame.mime,
          data: frame.data.toString("base64"),
          width: frame.width,
          height: frame.height,
          orientation: frame.orientation,
          ...(frame.posture && { posture: frame.posture }),
          ...(frame.screen && { screen: frame.screen }),
          ...(frame.unfolded && { unfolded: frame.unfolded }),
        }
        const waiters = [...screen.waiters]
        screen.waiters.clear()
        waiters.forEach((wake) => wake())
      }
      const live: Live = Object.assign(screen, {
        deviceId,
        lease: Date.now(),
        link: driverOf(deviceId).connect(deviceId, onFrame),
      })
      links.set(deviceId, live)
      void live.link.then(
        (link) =>
          link.ended.then((reason) => {
            if (live.closed) return
            closeLive(live)
            failThreadsOn(deviceId, reason)
          }),
        () => closeLive(live),
      )
      return live
    }

    const prepare = (
      threadId: string,
      initial: DeviceId | null,
      name: string,
      owned: boolean,
      start: (onStep: (step: PrepareStep) => void) => Promise<DeviceId>,
    ) => {
      let key = keyOf(threadId, initial ?? NEW)
      const running = preparing.get(key)
      if (running) return running
      const DETACHED = new DevicesError({ message: "The device was detached." })
      let deviceId = initial
      let slot: Slot = initial ?? NEW
      const detached = () => preparing.get(key) !== pending
      const place = (state: ThreadDevice) => {
        if (detached()) return state
        setState(threadId, state, slot)
        if (slotOf(state) !== slot) {
          preparing.delete(key)
          slot = slotOf(state)
          key = keyOf(threadId, slot)
          preparing.set(key, pending)
        }
        return state
      }
      const onStep = (step: PrepareStep) => place({ phase: "preparing", deviceId, name, owned, step })
      const pending: Promise<ThreadDevice> = Promise.resolve().then(async () => {
        try {
          deviceId = await start(onStep)
          if (detached()) throw DETACHED
          onStep("connecting")
          const link = await connect(deviceId).link
          const device = await findDevice(deviceId)
          if (detached()) throw DETACHED
          return place({
            phase: "ready",
            device: { ...device, ownerThreadId: owned ? threadId : null },
            screen: link.screen,
            control: controlOf(deviceId),
            agentWaiting: waitingOn(deviceId),
          })
        } catch (cause) {
          const failed: ThreadDevice = { phase: "failed", deviceId, name, owned, message: messageOf(cause) }
          if (cause === DETACHED && initial === null && deviceId !== null) {
            await detachNow(threadId, deviceId).catch(() => undefined)
          }
          return place(failed)
        } finally {
          if (preparing.get(key) === pending) preparing.delete(key)
        }
      })
      preparing.set(key, pending)
      onStep(initial === null ? "creating" : "booting")
      return pending
    }

    const lookUp = async (threadId: string, deviceId: DeviceId) => {
      const device = await findDevice(deviceId).catch(() => null)
      const row = await readRow(threadId, deviceId)
      if (!row) throw new DevicesError({ message: "The device was detached." })
      return { device, owned: row.owned }
    }

    const attachExisting = async (
      threadId: string,
      deviceId: DeviceId,
      known?: { readonly device: Device | null; readonly owned: boolean },
    ) => {
      const running = preparing.get(keyOf(threadId, deviceId))
      if (running) return running
      const { device, owned } = known ?? (await lookUp(threadId, deviceId))
      return prepare(threadId, deviceId, device?.name ?? deviceId, owned, async (onStep) => {
        if (!device) throw new DevicesError({ message: "This device no longer exists on the machine." })
        onStep("booting")
        await driverOf(deviceId).boot(deviceId, onStep)
        return deviceId
      })
    }

    const nameFor = async (threadId: string) => {
      const base = `hinacode-${threadId.slice(0, 8)}`
      const taken = new Set((await options.drivers.ios.list()).map((device) => device.name))
      let name = base
      for (let count = 2; taken.has(name); count++) name = `${base}-${count}`
      return name
    }

    const createFor = async (threadId: string, model: SimulatorModelId | null, client: DeviceClient | null) => {
      const running = preparing.get(keyOf(threadId, NEW))
      if (running) return running
      const name = await nameFor(threadId)
      return prepare(threadId, null, name, true, async (onStep) => {
        onStep("creating")
        let created: DeviceId | null = null
        try {
          return await options.drivers.ios.create(name, model, onStep, async (deviceId) => {
            created = deviceId
            await writeRow(threadId, { deviceId, owned: true }, client)
          })
        } catch (cause) {
          if (created !== null) await detachNow(threadId, created).catch(() => undefined)
          throw cause
        }
      })
    }

    const restore = async (threadId: string) => {
      const missing = (await readRows(threadId)).filter((row) => !current(threadId, row.deviceId))
      if (missing.length === 0) return listOf(threadId)
      const found = await Promise.all(missing.map((row) => findDevice(row.deviceId).catch(() => null)))
      const kept = new Set((await readRows(threadId)).map((row) => row.deviceId))
      missing.forEach((row, index) => {
        if (!kept.has(row.deviceId) || current(threadId, row.deviceId) || deleting.has(row.deviceId)) return
        void attachExisting(threadId, row.deviceId, { device: found[index] ?? null, owned: row.owned })
      })
      return listOf(threadId)
    }

    const settle = async (threadId: string, state: ThreadDevice): Promise<ReadyDevice> => {
      const settled =
        state.phase === "preparing" ? await (preparing.get(keyOf(threadId, slotOf(state))) ?? state) : state
      if (settled.phase === "failed") throw new DevicesError({ message: settled.message })
      if (settled.phase !== "ready") throw new DevicesError({ message: "The device is not ready yet." })
      return settled
    }

    const settledOn = async (threadId: string, deviceId: DeviceId) => {
      const state = current(threadId, deviceId) ?? (await restore(threadId), current(threadId, deviceId))
      if (!state) throw new DevicesError({ message: "This device is not attached to the thread." })
      return settle(threadId, state)
    }

    const ready = async (threadId: string, deviceId: DeviceId) => {
      const state = await settledOn(threadId, deviceId)
      return { state, live: connect(deviceId) }
    }

    const chosen = async (threadId: string, device: string | undefined, client?: DeviceClient) => {
      const entries = await restore(threadId)
      if (entries.length === 0) {
        if (device !== undefined) {
          throw new DevicesError({ message: "No device is attached to this thread. Leave out `device` to create one." })
        }
        const created = await settle(threadId, await createFor(threadId, null, client ?? null))
        return { state: created, live: connect(created.device.id) }
      }
      const wanted = device?.trim().toLowerCase()
      const matches =
        wanted === undefined
          ? entries
          : entries.filter(
              (entry) =>
                threadDeviceId(entry)?.toLowerCase() === wanted ||
                (entry.phase === "ready" && entry.device.name.toLowerCase() === wanted),
            )
      const [only] = matches
      if (matches.length !== 1 || !only) {
        const names = entries.flatMap((entry) => (entry.phase === "ready" ? [describeDevice(entry)] : []))
        const known = names.length > 0 ? ` The thread has ${names.join(", ")}.` : ""
        throw new DevicesError({
          message:
            matches.length === 0
              ? `No device on this thread is called ${JSON.stringify(device)}.${known}`
              : `This thread has more than one device, so pass \`device\` with a name or id.${known}`,
        })
      }
      const state = await settle(threadId, only)
      return { state, live: connect(state.device.id) }
    }

    const newestFrame = async (live: Live, after: number, waitMs: number) => {
      if (live.latest && live.latest.sequence > after) return live.latest
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          live.waiters.delete(wake)
          resolve()
        }, waitMs)
        const wake = () => {
          clearTimeout(timer)
          resolve()
        }
        live.waiters.add(wake)
      })
      return live.latest && live.latest.sequence > after ? live.latest : null
    }

    const setControl = (threadId: string, deviceId: DeviceId, control: DeviceControl) => {
      const state = current(threadId, deviceId)
      if (!state) throw new DevicesError({ message: "This device is not attached to the thread." })
      if (state.phase !== "ready") return state
      const owner = userControl.get(deviceId)
      if (control === "agent" && owner !== undefined && owner !== threadId) {
        throw new DevicesError({
          message: "The user has control of this device in another thread. Hand it back there.",
        })
      }
      if (control === "user") userControl.set(deviceId, threadId)
      else userControl.delete(deviceId)
      const agentWaiting = control === "user" ? waitingOn(deviceId) : null
      for (const [other, entries] of states) {
        const entry = entries.get(deviceId)
        if (entry?.phase !== "ready" || (entry.control === control && entry.agentWaiting === agentWaiting)) continue
        setState(other, { ...entry, control, agentWaiting })
      }
      return current(threadId, deviceId)!
    }

    const refreshWaiting = (deviceId: DeviceId) => {
      const agentWaiting = waitingOn(deviceId)
      for (const [threadId, entries] of states) {
        const state = entries.get(deviceId)
        if (state?.phase === "ready" && state.control === "user" && state.agentWaiting !== agentWaiting) {
          setState(threadId, { ...state, agentWaiting })
        }
      }
    }

    const waitForHandBack = async (threadId: string, deviceId: DeviceId, action: AgentAction, signal: AbortSignal) => {
      const key = keyOf(threadId, deviceId)
      waiting.set(key, [...(waiting.get(key) ?? []), action])
      refreshWaiting(deviceId)
      try {
        await new Promise<void>((resolve, reject) => {
          const handBack = () => resolve()
          const resolvers = handBacks.get(key) ?? new Set()
          resolvers.add(handBack)
          handBacks.set(key, resolvers)
          signal.addEventListener(
            "abort",
            () => {
              handBacks.get(key)?.delete(handBack)
              reject(signal.reason)
            },
            { once: true },
          )
        })
      } finally {
        const rest = (waiting.get(key) ?? []).filter((each) => each !== action)
        if (rest.length === 0) waiting.delete(key)
        else waiting.set(key, rest)
        refreshWaiting(deviceId)
      }
    }

    const ensureEnabled = () => {
      if (!enabled) throw new DevicesError({ message: "Devices are off. Turn them on in Settings > Experimental." })
    }

    const attempt = <A>(work: (signal: AbortSignal) => Promise<A>) =>
      Effect.tryPromise({
        try: async (signal) => {
          ensureEnabled()
          return await work(signal)
        },
        catch: failure,
      })

    const list = () =>
      attempt(async (): Promise<DeviceHost> => {
        const [ios, android, checks, rows, holders] = await Promise.all([
          drivers.ios.support(),
          drivers.android.support(),
          allChecks(),
          ownedRows(),
          holderRows(),
        ])
        const owners = new Map(rows.map((row) => [row.deviceId, row.threadId]))
        const [iosDevices, androidDevices, models] = await Promise.all([
          ios.kind === "ready" ? drivers.ios.list() : [],
          android.kind === "ready" ? drivers.android.list() : [],
          ios.kind === "ready" ? drivers.ios.models() : [],
        ])
        return {
          ios,
          android,
          checks,
          devices: [...iosDevices, ...androidDevices].map((device) => ({
            ...device,
            ownerThreadId: owners.get(device.id) ?? null,
            holders: holders.flatMap(({ deviceId, ...holder }) => (deviceId === device.id ? [holder] : [])),
          })),
          models,
        }
      })

    const allChecks = async () => (await Promise.all([drivers.ios.checks(), drivers.android.checks()])).flat()

    const holderRows = () =>
      run(
        sql<{
          deviceId: string
          threadId: string
          clientId: string
          clientName: string | null
          threadTitle: string | null
          claimedAt: number | null
        }>`SELECT device_id, thread_id, client_id, client_name, thread_title, claimed_at FROM thread_device
           WHERE client_id IS NOT NULL ORDER BY rowid`.pipe(
          Effect.map((rows) =>
            rows.map((row) => ({
              deviceId: row.deviceId,
              client: row.clientName ?? row.clientId,
              clientId: row.clientId,
              threadId: row.threadId,
              threadTitle: row.threadTitle,
              seenAt: row.claimedAt ?? 0,
            })),
          ),
        ),
      )

    const detachNow = async (threadId: string, deviceId: DeviceId | null, remove = false) => {
      preparing.delete(keyOf(threadId, deviceId ?? NEW))
      if (deviceId === null) return removeState(threadId, NEW)
      const row = await readRow(threadId, deviceId)
      removeState(threadId, deviceId)
      const stillUsed = [...states.values()].some((entries) => entries.get(deviceId)?.phase === "ready")
      const live = links.get(deviceId)
      if (live && !stillUsed) closeLive(live)
      if (row?.owned || remove) await removeDevice(deviceId)
      await deleteRow(threadId, deviceId)
    }

    const removeDevice = async (deviceId: DeviceId) => {
      const driver = driverOf(deviceId)
      try {
        await driver.remove(deviceId)
      } catch (error) {
        const stillThere = (await driver.list()).some((device) => device.id === deviceId)
        if (stillThere) throw error
      }
    }

    const releaseThread = (threadId: string) =>
      Effect.promise(async () => {
        const slots = new Set<DeviceId | null>([
          ...(await readRows(threadId)).map((row) => row.deviceId),
          ...listOf(threadId).map(threadDeviceId),
        ])
        const results = await Promise.allSettled([...slots].map((deviceId) => detachNow(threadId, deviceId)))
        return results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []))
      }).pipe(
        Effect.flatMap((failures) =>
          failures.length === 0 ? Effect.void : Effect.logWarning("could not release a thread's device", ...failures),
        ),
      )

    const actOnce = (
      threadId: string,
      device: string | undefined,
      action: AgentAction,
      commands: ReadonlyArray<DeviceCommand>,
      first: boolean,
      client: DeviceClient | undefined,
    ) =>
      attempt(async (signal): Promise<AgentInput> => {
        const { state, live } = await chosen(threadId, device, client)
        if (state.control === "user") {
          await waitForHandBack(threadId, state.device.id, action, signal)
          return "handedBack"
        }
        if (first) announce(state.device.id, action)
        await (await live.link).send(commands)
        return "done"
      })

    const act = (
      threadId: string,
      device: string | undefined,
      action: AgentAction,
      input: AgentSteps,
      client?: DeviceClient,
    ) =>
      Effect.gen(function* () {
        const { steps, gapMs = 0, release = [] } = input
        for (const [index, commands] of steps.entries()) {
          if (index > 0 && gapMs > 0) yield* Effect.sleep(gapMs)
          const outcome = yield* actOnce(threadId, device, action, commands, index === 0, client)
          if (outcome === "handedBack") {
            if (index > 0 && release.length > 0) yield* actOnce(threadId, device, action, release, false, client)
            return outcome
          }
        }
        return "done" as const
      })

    const screenshot = (threadId: string, device: string | undefined, client?: DeviceClient) =>
      attempt(async () => {
        const { state, live } = await chosen(threadId, device, client)
        const frame = live.latest ?? (await newestFrame(live, 0, 5000))
        if (!frame) throw new DevicesError({ message: "The device has not sent a frame yet. Try again in a moment." })
        return { frame, state, screen: shownScreen(frame, state.screen) }
      })

    const installTarget = async (
      threadId: string,
      device: string | undefined,
      kind: InstallKind,
      client?: DeviceClient,
    ) => {
      const { state } = await chosen(threadId, device, client)
      if (state.device.platform !== platformOfKind[kind]) {
        const build = kind === "app" ? "An iOS .app" : "An Android .apk"
        throw new DevicesError({ message: `${build} cannot be installed on ${describeDevice(state)}.` })
      }
      return state
    }

    const installOn = async (state: ReadyDevice, path: string) => ({
      device: state.device.name,
      app: await driverOf(state.device.id).install(state.device.id, path),
    })

    const dropUpload = (uploadId: string) => {
      const upload = uploads.get(uploadId)
      uploads.delete(uploadId)
      if (upload) void upload.written.finally(() => rm(upload.path, { force: true })).catch(() => undefined)
    }

    const uploadOf = (threadId: string, uploadId: string) => {
      const upload = uploads.get(uploadId)
      if (!upload || upload.threadId !== threadId) {
        throw new DevicesError({ message: "This upload does not exist or was dropped after a minute without data." })
      }
      return upload
    }

    const uploadBegin = (input: RpcRequest<"device.install.begin">) =>
      attempt(async () => {
        const state = await installTarget(input.threadId, input.device, input.kind, input.client)
        await mkdir(options.uploadsDir, { recursive: true })
        const uploadId = randomUUID()
        uploads.set(uploadId, {
          threadId: input.threadId,
          deviceId: state.device.id,
          kind: input.kind,
          bytes: input.bytes,
          path: join(options.uploadsDir, uploadId),
          hash: createHash("sha256"),
          received: 0,
          nextIndex: 0,
          touchedAt: Date.now(),
          written: Promise.resolve(),
        })
        return { uploadId }
      })

    const uploadChunk = (input: RpcRequest<"device.install.chunk">) =>
      attempt(async () => {
        const upload = uploadOf(input.threadId, input.uploadId)
        if (input.index !== upload.nextIndex) {
          dropUpload(input.uploadId)
          throw new DevicesError({ message: `Expected chunk ${upload.nextIndex}, got ${input.index}. Start over.` })
        }
        const data = Buffer.from(input.data, "base64")
        if (upload.received + data.length > upload.bytes) {
          dropUpload(input.uploadId)
          throw new DevicesError({ message: `The upload is larger than the ${upload.bytes} bytes it declared.` })
        }
        upload.nextIndex += 1
        upload.received += data.length
        upload.touchedAt = Date.now()
        upload.hash.update(data)
        upload.written = upload.written.then(() => appendFile(upload.path, data))
        await upload.written.catch((cause: unknown) => {
          dropUpload(input.uploadId)
          throw cause
        })
      })

    const uploadEnd = (input: RpcRequest<"device.install.end">) =>
      attempt(async () => {
        const upload = uploadOf(input.threadId, input.uploadId)
        uploads.delete(input.uploadId)
        const unpacked = `${upload.path}.d`
        try {
          await upload.written
          if (upload.received !== upload.bytes) {
            throw new DevicesError({ message: `Received ${upload.received} of ${upload.bytes} bytes. Start over.` })
          }
          if (upload.hash.digest("hex") !== input.sha256) {
            throw new DevicesError({ message: "The upload's SHA-256 does not match. Start over." })
          }
          const { state } = await chosen(upload.threadId, upload.deviceId)
          const path = upload.kind === "app" ? await unpackApp(upload.path, unpacked) : upload.path
          return await installOn(state, path)
        } finally {
          await rm(upload.path, { force: true })
          await rm(unpacked, { recursive: true, force: true })
        }
      })

    const dropIdleUploads = Effect.sync(() => {
      for (const [uploadId, upload] of uploads) {
        if (Date.now() - upload.touchedAt > UPLOAD_IDLE_MS) dropUpload(uploadId)
      }
    })

    const pick = (input: RpcRequest<"device.pick">) =>
      attempt(async (): Promise<PickedDeviceElement | null> => {
        const { state, live } = await ready(input.threadId, input.deviceId)
        const elements = await driverOf(state.device.id).describe(state.device.id)
        const screen = live.latest ? shownScreen(live.latest, state.screen) : state.screen
        const x = input.x * screen.width
        const y = input.y * screen.height
        const under = elements
          .filter(
            ({ frame }) => x >= frame.x && x <= frame.x + frame.width && y >= frame.y && y <= frame.y + frame.height,
          )
          .filter(({ frame }) => frame.width < screen.width || frame.height < screen.height)
          .sort((a, b) => a.frame.width * a.frame.height - b.frame.width * b.frame.height)[0]
        return under ? { device: state.device.name, platform: state.device.platform, element: under } : null
      })

    const expireLeases = Effect.sync(() => {
      const expiry = options.leaseMs ?? 15000
      for (const live of links.values()) {
        if (Date.now() - live.lease <= expiry) continue
        closeLive(live)
        const holder = userControl.get(live.deviceId)
        if (holder === undefined) continue
        if (current(holder, live.deviceId)) setControl(holder, live.deviceId, "agent")
        else userControl.delete(live.deviceId)
      }
    })
    const closeAll = () => {
      for (const live of links.values()) closeLive(live)
      for (const sound of sounds.values()) closeSound(sound)
    }
    const expireSounds = Effect.map(Clock.currentTimeMillis, (now) => {
      for (const sound of sounds.values()) if (now - sound.heardAt > AUDIO_LEASE_MS) closeSound(sound)
    })
    const releaseArchived = sql<{ threadId: string }>`
      SELECT DISTINCT thread_device.thread_id FROM thread_device LEFT JOIN thread ON thread.id = thread_device.thread_id
      WHERE thread_device.client_id IS NULL AND (thread.id IS NULL OR thread.status = 'archived')
    `.pipe(
      Effect.flatMap((rows) => Effect.forEach(rows, (row) => releaseThread(row.threadId), { discard: true })),
      Effect.catchCause((cause) => Effect.logWarning("device cleanup failed", cause)),
    )
    yield* Effect.all([expireLeases, expireSounds, releaseArchived, dropIdleUploads]).pipe(
      Effect.when(Effect.sync(() => enabled)),
      Effect.schedule(Schedule.spaced(5000)),
      Effect.forkIn(scope),
    )

    yield* (yield* settings.changes).pipe(
      Stream.runForEach((value) =>
        Effect.sync(() => {
          enabled = value.experimental.devices
          if (!enabled) closeAll()
        }),
      ),
      Effect.forkIn(scope),
    )
    yield* Effect.addFinalizer(() => Effect.sync(closeAll))

    return Devices.of({
      enabled: () => enabled,
      list,
      get: (threadId) => attempt(() => restore(threadId)),
      attach: (threadId, deviceId, client) =>
        attempt(async () => {
          if (deleting.has(deviceId)) throw new DevicesError({ message: "This device is being deleted." })
          attaching.set(deviceId, (attaching.get(deviceId) ?? 0) + 1)
          try {
            const existing = current(threadId, deviceId)
            if (existing && existing.phase !== "failed") return existing
            const owner = (await ownedRows()).find((row) => row.deviceId === deviceId)
            if (owner && owner.threadId !== threadId) {
              throw new DevicesError({
                message:
                  "Another thread created this simulator, and archiving that thread deletes it. Create one here.",
              })
            }
            await writeRow(threadId, { deviceId, owned: false }, client ?? null)
            return await attachExisting(threadId, deviceId)
          } finally {
            const count = (attaching.get(deviceId) ?? 1) - 1
            if (count === 0) attaching.delete(deviceId)
            else attaching.set(deviceId, count)
          }
        }),
      create: (threadId, model, client) =>
        attempt(async () => {
          if (current(threadId, NEW)?.phase === "failed") removeState(threadId, NEW)
          return createFor(threadId, model ?? null, client ?? null)
        }),
      detach: (threadId, deviceId) => attempt(() => detachNow(threadId, deviceId)),
      delete: (threadId, deviceId) =>
        attempt(async () => {
          if (deleting.has(deviceId)) throw new DevicesError({ message: "This device is being deleted." })
          if (attaching.has(deviceId))
            throw new DevicesError({ message: "This device is still attaching. Try again once it is ready." })
          deleting.add(deviceId)
          try {
            const rows = await run(
              sql<{
                threadId: string
              }>`SELECT thread_id FROM thread_device WHERE device_id = ${deviceId} AND thread_id != ${threadId}`,
            )
            const elsewhere = [...states].some(([other, entries]) => other !== threadId && entries.has(deviceId))
            if (rows.length > 0 || elsewhere) {
              throw new DevicesError({ message: "Another thread has this device attached. Detach it there first." })
            }
            await detachNow(threadId, deviceId, true)
          } finally {
            deleting.delete(deviceId)
          }
        }),
      shutdown: (deviceId) =>
        attempt(async () => {
          if (deleting.has(deviceId)) throw new DevicesError({ message: "This device is being deleted." })
          const live = links.get(deviceId)
          if (live) closeLive(live)
          const sound = sounds.get(deviceId)
          if (sound) closeSound(sound)
          failThreadsOn(deviceId, "The device was shut down.")
          await driverOf(deviceId).shutdown(deviceId)
        }),
      frame: (input) =>
        attempt(async () => {
          if (!input.visible) return { frame: null }
          const { live } = await ready(input.threadId, input.deviceId)
          live.lease = Date.now()
          await live.link
          return { frame: await newestFrame(live, input.after, FRAME_WAIT_MS) }
        }),
      command: (input) =>
        attempt(async () => {
          setControl(input.threadId, input.deviceId, "user")
          const { live } = await ready(input.threadId, input.deviceId)
          await (await live.link).send(input.commands)
        }),
      control: (threadId, deviceId, control) => attempt(async () => setControl(threadId, deviceId, control)),
      pick,
      act,
      screenshot,
      describe: (threadId, device, client) =>
        attempt(async () => {
          const { state } = await chosen(threadId, device, client)
          return driverOf(state.device.id).describe(state.device.id)
        }),
      launch: (threadId, device, app, client) =>
        attempt(async (signal): Promise<AgentInput> => {
          const { state } = await chosen(threadId, device, client)
          const action: AgentAction = { kind: "launch", app }
          if (state.control === "user") {
            await waitForHandBack(threadId, state.device.id, action, signal)
            return "handedBack"
          }
          announce(state.device.id, action)
          await driverOf(state.device.id).launch(state.device.id, app)
          return "done"
        }),
      claim: ({ client, threads }) =>
        Effect.gen(function* () {
          if (!enabled) return
          const titles = new Map(threads.map((thread) => [thread.id, thread.title]))
          const held = yield* sql<{
            threadId: string
          }>`SELECT DISTINCT thread_id FROM thread_device WHERE client_id = ${client.id}`
          const now = Date.now()
          for (const { threadId } of held) {
            if (!titles.has(threadId)) {
              yield* releaseThread(threadId)
              continue
            }
            yield* sql`UPDATE thread_device SET claimed_at = ${now}, client_name = ${client.name}, thread_title = ${titles.get(threadId) ?? null}
                       WHERE client_id = ${client.id} AND thread_id = ${threadId}`
          }
        }).pipe(Effect.mapError(failure)),
      release: (clientId) =>
        sql<{ threadId: string }>`SELECT DISTINCT thread_id FROM thread_device WHERE client_id = ${clientId}`.pipe(
          Effect.flatMap((held) => Effect.forEach(held, ({ threadId }) => releaseThread(threadId), { discard: true })),
          Effect.mapError(failure),
        ),
      setup: (requirement) =>
        attempt(() => drivers[requirementPlatform[requirement]].setup(requirement)).pipe(Effect.andThen(list())),
      checks: () => Effect.tryPromise({ try: allChecks, catch: failure }),
      logs: ({ threadId, device, app, sinceSeconds, client }) =>
        attempt(async () => {
          const { state } = await chosen(threadId, device, client)
          const text = await driverOf(state.device.id).logs(state.device.id, app ?? null, sinceSeconds)
          return { device: state.device.name, text }
        }),
      install: (threadId, device, path) =>
        attempt(async () => installOn(await installTarget(threadId, device, await installKindOf(path)), path)),
      uploadBegin,
      uploadChunk,
      uploadEnd,
      audio: (input) =>
        Effect.flatMap(Clock.currentTimeMillis, (now) =>
          attempt(async (): Promise<DeviceAudio> => {
            await settledOn(input.threadId, input.deviceId)
            const sound = listen(input.deviceId)
            sound.heardAt = now
            const link = await sound.link
            const after = input.after === -1 || input.after > audioSequence ? audioSequence : input.after
            return { rate: link.rate, channels: link.channels, chunks: await nextChunks(sound, after) }
          }),
        ),
    })
  })

export const devicesLayer = (options: DevicesOptions) => Layer.effect(Devices, make(options))
