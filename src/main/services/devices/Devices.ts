import { Context, Effect, Layer, Schedule, Schema, Stream } from "effect"
import { SqlClient } from "effect/sql"
import type { RpcRequest } from "../../../shared/contract.ts"
import {
  devicePlatformOf,
  type Device,
  type DeviceCommand,
  type DeviceControl,
  type DeviceElement,
  type DeviceFrame,
  type DeviceHost,
  type DeviceId,
  type DevicePlatform,
  type PickedDeviceElement,
  type PrepareStep,
  type SimulatorModelId,
  threadDeviceId,
  type ThreadDevice,
  type ThreadDevices,
} from "../../../shared/device.ts"
import { Events } from "../Events.ts"
import { Settings } from "../Settings.ts"
import type { DeviceLink, DevicePlatformDriver, Frame } from "./platform.ts"

export class DevicesError extends Schema.TaggedError<DevicesError>()("DevicesError", { message: Schema.String }) {}

export type AgentInput = "done" | "handedBack"

export type ReadyDevice = Extract<ThreadDevice, { phase: "ready" }>

export class Devices extends Context.Service<
  Devices,
  {
    readonly enabled: () => boolean
    /** The devices on this machine. Calls route by thread, so this is the thread's machine. */
    readonly list: () => Effect.Effect<DeviceHost, DevicesError>
    /** The thread's devices, reconnecting the ones it had before a restart. */
    readonly get: (threadId: string) => Effect.Effect<ThreadDevices, DevicesError>
    readonly attach: (threadId: string, deviceId: DeviceId) => Effect.Effect<ThreadDevice, DevicesError>
    readonly create: (threadId: string, model?: SimulatorModelId) => Effect.Effect<ThreadDevice, DevicesError>
    readonly detach: (threadId: string, deviceId: DeviceId | null) => Effect.Effect<void, DevicesError>
    /** Deletes any device on the machine, the user's own included, unless another thread has it attached. */
    readonly delete: (threadId: string, deviceId: DeviceId) => Effect.Effect<void, DevicesError>
    readonly frame: (input: RpcRequest<"device.frame">) => Effect.Effect<{ frame: DeviceFrame | null }, DevicesError>
    /** The user's input. It takes control of that device from the agent. */
    readonly command: (input: RpcRequest<"device.command">) => Effect.Effect<void, DevicesError>
    readonly control: (
      threadId: string,
      deviceId: DeviceId,
      control: DeviceControl,
    ) => Effect.Effect<ThreadDevice, DevicesError>
    readonly pick: (input: RpcRequest<"device.pick">) => Effect.Effect<PickedDeviceElement | null, DevicesError>
    /**
     * The agent's input. It waits while the user has control and skips acting once they hand back.
     * This and the methods after it take `device`, a device's id or name. It may be left out while the thread has at
     * most one device, and a thread with none gets a new simulator.
     */
    readonly act: (
      threadId: string,
      device: string | undefined,
      commands: ReadonlyArray<DeviceCommand>,
    ) => Effect.Effect<AgentInput, DevicesError>
    /** The device's newest frame. */
    readonly screenshot: (
      threadId: string,
      device: string | undefined,
    ) => Effect.Effect<{ readonly frame: DeviceFrame; readonly state: ReadyDevice }, DevicesError>
    readonly describe: (
      threadId: string,
      device: string | undefined,
    ) => Effect.Effect<ReadonlyArray<DeviceElement>, DevicesError>
    readonly launch: (threadId: string, device: string | undefined, app: string) => Effect.Effect<void, DevicesError>
  }
>()("hinacode/Devices") {}

export interface DevicesOptions {
  readonly drivers: Record<DevicePlatform, DevicePlatformDriver>
  readonly simslimAvailable: () => Promise<boolean>
  readonly leaseMs?: number
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

interface Row {
  readonly deviceId: DeviceId
  readonly owned: boolean
}

/** Where a thread keeps the simulator it is still creating, which has no id yet. */
const NEW = "new"
type Slot = DeviceId | typeof NEW
const slotOf = (entry: ThreadDevice): Slot => threadDeviceId(entry) ?? NEW
const keyOf = (threadId: string, slot: Slot) => `${threadId}\n${slot}`
const describeDevice = (state: ReadyDevice) => `${state.device.name} (${state.device.id})`
const FRAME_WAIT_MS = 1000
const messageOf = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause))
const failure = (cause: unknown) =>
  cause instanceof DevicesError ? cause : new DevicesError({ message: messageOf(cause) })

const make = (options: DevicesOptions) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const events = yield* Events
    const settings = yield* Settings
    const scope = yield* Effect.scope
    const runFork = Effect.runForkWith(yield* Effect.context<never>())

    let enabled = yield* settings.get.pipe(
      Effect.map((value) => value.experimental.devices),
      Effect.orElseSucceed(() => false),
    )
    /** Per thread, its devices by slot, in the order they were attached. */
    const states = new Map<string, Map<Slot, ThreadDevice>>()
    const links = new Map<DeviceId, Live>()
    // One count for every stream, so a stream rebuilt after its lease ran out still numbers past what viewers saw.
    let frameSequence = 0
    /** The maps below are keyed by `keyOf(thread, slot)`. */
    const preparing = new Map<string, Promise<ThreadDevice>>()
    const handBacks = new Map<string, Set<() => void>>()
    const waiting = new Map<string, number>()
    const userControl = new Map<DeviceId, string>()
    // Reserve before the first await: SQL checks alone leave a gap between checking and deleting.
    const deleting = new Set<DeviceId>()
    const attaching = new Map<DeviceId, number>()

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
    const writeRow = (threadId: string, row: Row) =>
      run(
        sql`INSERT INTO thread_device (thread_id, device_id, owned) VALUES (${threadId}, ${row.deviceId}, ${row.owned ? 1 : 0})
            ON CONFLICT (thread_id, device_id) DO NOTHING`,
      )
    const deleteRow = (threadId: string, deviceId: DeviceId) =>
      run(sql`DELETE FROM thread_device WHERE thread_id = ${threadId} AND device_id = ${deviceId}`)
    const ownedRows = () =>
      run(sql<{ threadId: string; deviceId: string }>`SELECT thread_id, device_id FROM thread_device WHERE owned = 1`)

    const driverOf = (deviceId: DeviceId) => options.drivers[devicePlatformOf(deviceId)]

    const listOf = (threadId: string): ThreadDevices => [...(states.get(threadId)?.values() ?? [])]
    const current = (threadId: string, slot: Slot) => states.get(threadId)?.get(slot) ?? null

    const releaseHandBacks = (key: string) => {
      const resolvers = handBacks.get(key)
      handBacks.delete(key)
      resolvers?.forEach((resolve) => resolve())
    }

    const publish = (threadId: string) =>
      runFork(events.publish({ type: "device.updated", threadId, devices: listOf(threadId) }))

    /** Puts `state` in its slot, taking the place of `from` when a new simulator gets its id. */
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
      [...states.keys()].some((threadId) => (waiting.get(keyOf(threadId, deviceId)) ?? 0) > 0)

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
      // The frame callback holds `screen`, not `live`, because a driver may call it before connect returns.
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

    /**
     * Boots when needed and connects, moving the device through `preparing` to `ready`. Concurrent calls share one run.
     * A run owns its slot while `preparing` maps the slot to it. Detaching drops that entry, and the run stops placing.
     */
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
      // Started on the next tick, so `preparing` holds the run before its first step places anything.
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
          // Nobody sees a simulator created for a run that was detached, so it goes too.
          if (cause === DETACHED && initial === null && deviceId !== null) {
            await detachNow(threadId, deviceId).catch(() => undefined)
          }
          return place(failed)
        } finally {
          if (preparing.get(key) === pending) preparing.delete(key)
        }
      })
      preparing.set(key, pending)
      // Placed now, so a caller that lists the thread's devices right after sees this one, as restore needs.
      onStep(initial === null ? "creating" : "booting")
      return pending
    }

    /** The device and its row, read last so a detach during the lookup is seen. */
    const lookUp = async (threadId: string, deviceId: DeviceId) => {
      const device = await findDevice(deviceId).catch(() => null)
      const row = await readRow(threadId, deviceId)
      if (!row) throw new DevicesError({ message: "The device was detached." })
      return { device, owned: row.owned }
    }

    /** `known` is what the caller looked up already: the device, or null when it is gone, and whether it is owned. */
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

    /** `hinacode-<thread>`, then `-2`, `-3` and on, so the agent can tell a thread's simulators apart by name. */
    const nameFor = async (threadId: string) => {
      const base = `hinacode-${threadId.slice(0, 8)}`
      const taken = new Set((await options.drivers.ios.list()).map((device) => device.name))
      let name = base
      for (let count = 2; taken.has(name); count++) name = `${base}-${count}`
      return name
    }

    const createFor = async (threadId: string, model: SimulatorModelId | null = null) => {
      const running = preparing.get(keyOf(threadId, NEW))
      if (running) return running
      const name = await nameFor(threadId)
      return prepare(threadId, null, name, true, async (onStep) => {
        onStep("creating")
        let created: DeviceId | null = null
        try {
          return await options.drivers.ios.create(name, model, onStep, async (deviceId) => {
            // Recorded before it slims and boots, so a failure or a quit midway still leaves it to clean up.
            created = deviceId
            await writeRow(threadId, { deviceId, owned: true })
          })
        } catch (cause) {
          if (created !== null) await detachNow(threadId, created).catch(() => undefined)
          throw cause
        }
      })
    }

    /** Starts reconnecting the devices the thread had before a restart. */
    const restore = async (threadId: string) => {
      const missing = (await readRows(threadId)).filter((row) => !current(threadId, row.deviceId))
      if (missing.length === 0) return listOf(threadId)
      // Looked up before any is placed, so the tabs come back in the order they were attached.
      const found = await Promise.all(missing.map((row) => findDevice(row.deviceId).catch(() => null)))
      // Read again, so a device detached during the lookup stays detached.
      const kept = new Set((await readRows(threadId)).map((row) => row.deviceId))
      missing.forEach((row, index) => {
        if (!kept.has(row.deviceId) || current(threadId, row.deviceId) || deleting.has(row.deviceId)) return
        void attachExisting(threadId, row.deviceId, { device: found[index] ?? null, owned: row.owned })
      })
      return listOf(threadId)
    }

    /** Waits out a device's preparation, and fails unless it ends ready. */
    const settle = async (threadId: string, state: ThreadDevice): Promise<ReadyDevice> => {
      const settled =
        state.phase === "preparing" ? await (preparing.get(keyOf(threadId, slotOf(state))) ?? state) : state
      if (settled.phase === "failed") throw new DevicesError({ message: settled.message })
      if (settled.phase !== "ready") throw new DevicesError({ message: "The device is not ready yet." })
      return settled
    }

    const ready = async (threadId: string, deviceId: DeviceId) => {
      const state = current(threadId, deviceId) ?? (await restore(threadId), current(threadId, deviceId))
      if (!state) throw new DevicesError({ message: "This device is not attached to the thread." })
      const settled = await settle(threadId, state)
      return { state: settled, live: connect(deviceId) }
    }

    /** The device the agent means: the one named, the only one, or a new simulator when the thread has none. */
    const chosen = async (threadId: string, device: string | undefined) => {
      const entries = await restore(threadId)
      if (entries.length === 0) {
        if (device !== undefined) {
          throw new DevicesError({ message: "No device is attached to this thread. Leave out `device` to create one." })
        }
        const created = await settle(threadId, await createFor(threadId))
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
      const agentWaiting = control === "user" && waitingOn(deviceId)
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

    /** Resolves on hand back, and stops waiting when the agent's call is interrupted. */
    const waitForHandBack = async (threadId: string, deviceId: DeviceId, signal: AbortSignal) => {
      const key = keyOf(threadId, deviceId)
      waiting.set(key, (waiting.get(key) ?? 0) + 1)
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
        const count = (waiting.get(key) ?? 1) - 1
        if (count === 0) waiting.delete(key)
        else waiting.set(key, count)
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
        const [ios, android, simslim, rows] = await Promise.all([
          options.drivers.ios.support(),
          options.drivers.android.support(),
          options.simslimAvailable(),
          ownedRows(),
        ])
        const owners = new Map(rows.map((row) => [row.deviceId, row.threadId]))
        const [iosDevices, androidDevices, models] = await Promise.all([
          ios.kind === "ready" ? options.drivers.ios.list() : [],
          android.kind === "ready" ? options.drivers.android.list() : [],
          ios.kind === "ready" ? options.drivers.ios.models() : [],
        ])
        return {
          ios,
          android,
          simslim,
          devices: [...iosDevices, ...androidDevices].map((device) => ({
            ...device,
            ownerThreadId: owners.get(device.id) ?? null,
          })),
          models,
        }
      })

    /** Deletes the device too when HinaCode created it for the thread, or when `remove` asks to. */
    const detachNow = async (threadId: string, deviceId: DeviceId | null, remove = false) => {
      preparing.delete(keyOf(threadId, deviceId ?? NEW))
      if (deviceId === null) return removeState(threadId, NEW)
      const row = await readRow(threadId, deviceId)
      removeState(threadId, deviceId)
      const stillUsed = [...states.values()].some((entries) => entries.get(deviceId)?.phase === "ready")
      const live = links.get(deviceId)
      if (live && !stillUsed) closeLive(live)
      // The row goes only after the device, so a failed removal is retried instead of leaving it to look like the user's.
      if (row?.owned || remove) await driverOf(deviceId).remove(deviceId)
      await deleteRow(threadId, deviceId)
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

    const act = (threadId: string, device: string | undefined, commands: ReadonlyArray<DeviceCommand>) =>
      attempt(async (signal): Promise<AgentInput> => {
        const { state, live } = await chosen(threadId, device)
        if (state.control === "user") {
          await waitForHandBack(threadId, state.device.id, signal)
          return "handedBack"
        }
        await (await live.link).send(commands)
        return "done"
      })

    const screenshot = (threadId: string, device: string | undefined) =>
      attempt(async () => {
        const { state, live } = await chosen(threadId, device)
        const frame = live.latest ?? (await newestFrame(live, 0, 5000))
        if (!frame) throw new DevicesError({ message: "The device has not sent a frame yet. Try again in a moment." })
        return { frame, state }
      })

    const pick = (input: RpcRequest<"device.pick">) =>
      attempt(async (): Promise<PickedDeviceElement | null> => {
        const { state } = await ready(input.threadId, input.deviceId)
        const elements = await driverOf(state.device.id).describe(state.device.id)
        const x = input.x * state.screen.width
        const y = input.y * state.screen.height
        const under = elements
          .filter(
            ({ frame }) => x >= frame.x && x <= frame.x + frame.width && y >= frame.y && y <= frame.y + frame.height,
          )
          .filter(({ frame }) => frame.width < state.screen.width || frame.height < state.screen.height)
          .sort((a, b) => a.frame.width * a.frame.height - b.frame.width * b.frame.height)[0]
        return under ? { device: state.device.name, platform: state.device.platform, element: under } : null
      })

    const expireLeases = Effect.sync(() => {
      const expiry = options.leaseMs ?? 15000
      for (const live of links.values()) {
        if (Date.now() - live.lease <= expiry) continue
        closeLive(live)
        // Nobody is watching, so a viewer that vanished without handing back cannot leave the agent waiting.
        const holder = userControl.get(live.deviceId)
        if (holder === undefined) continue
        if (current(holder, live.deviceId)) setControl(holder, live.deviceId, "agent")
        else userControl.delete(live.deviceId)
      }
    })
    // A sweep rather than a call from archive or delete, so threads ended from any path, and before a crash, converge.
    const releaseArchived = sql<{ threadId: string }>`
      SELECT DISTINCT thread_device.thread_id FROM thread_device LEFT JOIN thread ON thread.id = thread_device.thread_id
      WHERE thread.id IS NULL OR thread.status = 'archived'
    `.pipe(
      Effect.flatMap((rows) => Effect.forEach(rows, (row) => releaseThread(row.threadId), { discard: true })),
      Effect.catchCause((cause) => Effect.logWarning("device cleanup failed", cause)),
    )
    yield* Effect.all([expireLeases, releaseArchived]).pipe(
      Effect.schedule(Schedule.spaced(5000)),
      Effect.forkIn(scope),
    )

    yield* (yield* settings.changes).pipe(
      Stream.runForEach((value) =>
        Effect.sync(() => {
          enabled = value.experimental.devices
          if (!enabled) [...links.values()].forEach(closeLive)
        }),
      ),
      Effect.forkIn(scope),
    )
    yield* Effect.addFinalizer(() => Effect.sync(() => [...links.values()].forEach(closeLive)))

    return Devices.of({
      enabled: () => enabled,
      list,
      get: (threadId) => attempt(() => restore(threadId)),
      attach: (threadId, deviceId) =>
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
            await writeRow(threadId, { deviceId, owned: false })
            return await attachExisting(threadId, deviceId)
          } finally {
            const count = (attaching.get(deviceId) ?? 1) - 1
            if (count === 0) attaching.delete(deviceId)
            else attaching.set(deviceId, count)
          }
        }),
      create: (threadId, model) =>
        attempt(async () => {
          if (current(threadId, NEW)?.phase === "failed") removeState(threadId, NEW)
          return createFor(threadId, model ?? null)
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
      describe: (threadId, device) =>
        attempt(async () => {
          const { state } = await chosen(threadId, device)
          return driverOf(state.device.id).describe(state.device.id)
        }),
      launch: (threadId, device, app) =>
        attempt(async (signal) => {
          const { state } = await chosen(threadId, device)
          if (state.control === "user") {
            await waitForHandBack(threadId, state.device.id, signal)
            return
          }
          await driverOf(state.device.id).launch(state.device.id, app)
        }),
    })
  })

export const devicesLayer = (options: DevicesOptions) => Layer.effect(Devices, make(options))
