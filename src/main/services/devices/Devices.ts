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
  type ThreadDevice,
} from "../../../shared/device.ts"
import { Events } from "../Events.ts"
import { Settings } from "../Settings.ts"
import type { DeviceLink, DevicePlatformDriver, Frame } from "./platform.ts"

export class DevicesError extends Schema.TaggedError<DevicesError>()("DevicesError", { message: Schema.String }) {}

export type AgentInput = "done" | "handedBack"

export class Devices extends Context.Service<
  Devices,
  {
    readonly enabled: () => boolean
    /** The devices on this machine. Calls route by thread, so this is the thread's machine. */
    readonly list: () => Effect.Effect<DeviceHost, DevicesError>
    readonly get: (threadId: string) => Effect.Effect<ThreadDevice, DevicesError>
    readonly attach: (threadId: string, deviceId: DeviceId) => Effect.Effect<ThreadDevice, DevicesError>
    readonly create: (threadId: string) => Effect.Effect<ThreadDevice, DevicesError>
    readonly detach: (threadId: string) => Effect.Effect<void, DevicesError>
    readonly frame: (input: RpcRequest<"device.frame">) => Effect.Effect<{ frame: DeviceFrame | null }, DevicesError>
    /** The user's input. It takes control from the agent. */
    readonly command: (input: RpcRequest<"device.command">) => Effect.Effect<void, DevicesError>
    readonly control: (threadId: string, control: DeviceControl) => Effect.Effect<ThreadDevice, DevicesError>
    readonly pick: (input: RpcRequest<"device.pick">) => Effect.Effect<PickedDeviceElement | null, DevicesError>
    /** The agent's input. It waits while the user has control and skips acting once they hand back. */
    readonly act: (threadId: string, commands: ReadonlyArray<DeviceCommand>) => Effect.Effect<AgentInput, DevicesError>
    /** The newest frame of the thread's device, creating a device first when the thread has none. */
    readonly screenshot: (threadId: string) => Effect.Effect<DeviceFrame, DevicesError>
    readonly describe: (threadId: string) => Effect.Effect<ReadonlyArray<DeviceElement>, DevicesError>
    readonly launch: (threadId: string, app: string) => Effect.Effect<void, DevicesError>
  }
>()("hinacode/Devices") {}

export interface DevicesOptions {
  readonly drivers: Record<DevicePlatform, DevicePlatformDriver>
  readonly simslimAvailable: () => Promise<boolean>
  readonly leaseMs?: number
}

interface Screen {
  latest: DeviceFrame | null
  sequence: number
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

const NONE: ThreadDevice = { phase: "none" }
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
    const states = new Map<string, ThreadDevice>()
    const links = new Map<DeviceId, Live>()
    const preparing = new Map<string, Promise<ThreadDevice>>()
    const handBacks = new Map<string, Set<() => void>>()
    const waiting = new Map<string, number>()

    const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)

    const readRow = (threadId: string) =>
      run(
        sql<{
          deviceId: string
          owned: number
        }>`SELECT device_id, owned FROM thread_device WHERE thread_id = ${threadId}`.pipe(
          Effect.map(([row]): Row | null => (row ? { deviceId: row.deviceId, owned: row.owned === 1 } : null)),
        ),
      )
    const writeRow = (threadId: string, row: Row) =>
      run(
        sql`INSERT INTO thread_device (thread_id, device_id, owned) VALUES (${threadId}, ${row.deviceId}, ${row.owned ? 1 : 0})
            ON CONFLICT (thread_id) DO UPDATE SET device_id = excluded.device_id, owned = excluded.owned`,
      )
    const deleteRow = (threadId: string) => run(sql`DELETE FROM thread_device WHERE thread_id = ${threadId}`)
    const ownedRows = () =>
      run(sql<{ threadId: string; deviceId: string }>`SELECT thread_id, device_id FROM thread_device WHERE owned = 1`)

    const driverOf = (deviceId: DeviceId) => options.drivers[devicePlatformOf(deviceId)]

    const current = (threadId: string) => states.get(threadId) ?? NONE

    const setState = (threadId: string, state: ThreadDevice) => {
      if (state.phase === "none") states.delete(threadId)
      else states.set(threadId, state)
      if (!(state.phase === "ready" && state.control === "user")) {
        const resolvers = handBacks.get(threadId)
        handBacks.delete(threadId)
        resolvers?.forEach((resolve) => resolve())
      }
      runFork(events.publish({ type: "device.updated", threadId, device: state }))
      return state
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

    const failThreadsOn = (deviceId: DeviceId, message: string) => {
      for (const [threadId, state] of states) {
        if (state.phase === "ready" && state.device.id === deviceId)
          setState(threadId, { phase: "failed", deviceId, message })
      }
    }

    const connect = (deviceId: DeviceId) => {
      const existing = links.get(deviceId)
      if (existing) {
        existing.lease = Date.now()
        return existing
      }
      // The frame callback holds `screen`, not `live`, because a driver may call it before connect returns.
      const screen: Screen = { latest: null, sequence: 0, waiters: new Set(), closed: false }
      const onFrame = (frame: Frame) => {
        if (screen.closed) return
        screen.latest = {
          sequence: ++screen.sequence,
          mime: frame.mime,
          data: frame.data.toString("base64"),
          width: frame.width,
          height: frame.height,
          orientation: frame.orientation,
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

    /** Boots when needed and connects, moving the thread through `preparing` to `ready`. Concurrent calls share one run. */
    const prepare = (threadId: string, start: (onStep: (step: PrepareStep) => void) => Promise<DeviceId>) => {
      const running = preparing.get(threadId)
      if (running) return running
      const pending = (async (): Promise<ThreadDevice> => {
        let deviceId: DeviceId | null = null
        const onStep = (step: PrepareStep) => setState(threadId, { phase: "preparing", deviceId, step })
        try {
          deviceId = await start(onStep)
          onStep("connecting")
          const link = await connect(deviceId).link
          const device = await findDevice(deviceId)
          const row = await readRow(threadId)
          return setState(threadId, {
            phase: "ready",
            device: { ...device, ownerThreadId: row?.owned ? threadId : null },
            screen: link.screen,
            control: "agent",
            agentWaiting: false,
          })
        } catch (cause) {
          return setState(threadId, { phase: "failed", deviceId, message: messageOf(cause) })
        } finally {
          preparing.delete(threadId)
        }
      })()
      preparing.set(threadId, pending)
      return pending
    }

    const attachExisting = (threadId: string, deviceId: DeviceId) =>
      prepare(threadId, async (onStep) => {
        onStep("booting")
        await driverOf(deviceId).boot(deviceId, onStep)
        return deviceId
      })

    const createFor = (threadId: string) =>
      prepare(threadId, async (onStep) => {
        onStep("creating")
        const deviceId = await options.drivers.ios.create(`hinacode-${threadId.slice(0, 8)}`, onStep)
        await writeRow(threadId, { deviceId, owned: true })
        return deviceId
      })

    /** The thread's device, reconnecting a remembered one after a restart. */
    const ensure = async (threadId: string, createWhenMissing: boolean): Promise<ThreadDevice> => {
      const state = current(threadId)
      if (state.phase === "ready") {
        await connect(state.device.id).link
        return current(threadId)
      }
      if (state.phase === "preparing") return preparing.get(threadId) ?? state
      const row = await readRow(threadId)
      if (row) return attachExisting(threadId, row.deviceId)
      if (createWhenMissing) return createFor(threadId)
      return state
    }

    const readyDevice = async (threadId: string, createWhenMissing: boolean) => {
      const state = await ensure(threadId, createWhenMissing)
      if (state.phase === "failed") throw new DevicesError({ message: state.message })
      if (state.phase !== "ready") {
        throw new DevicesError({ message: "No device is attached to this thread. Attach one in the Devices view." })
      }
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

    const send = async (threadId: string, commands: ReadonlyArray<DeviceCommand>) => {
      const { live } = await readyDevice(threadId, false)
      await (await live.link).send(commands)
    }

    const setControl = (threadId: string, control: DeviceControl) => {
      const state = current(threadId)
      if (state.phase !== "ready" || state.control === control) return state
      return setState(threadId, {
        ...state,
        control,
        agentWaiting: control === "user" && (waiting.get(threadId) ?? 0) > 0,
      })
    }

    const refreshWaiting = (threadId: string) => {
      const state = current(threadId)
      const agentWaiting = (waiting.get(threadId) ?? 0) > 0
      if (state.phase === "ready" && state.control === "user" && state.agentWaiting !== agentWaiting) {
        setState(threadId, { ...state, agentWaiting })
      }
    }

    const waitForHandBack = async (threadId: string) => {
      waiting.set(threadId, (waiting.get(threadId) ?? 0) + 1)
      refreshWaiting(threadId)
      try {
        await new Promise<void>((resolve) => {
          const resolvers = handBacks.get(threadId) ?? new Set()
          resolvers.add(resolve)
          handBacks.set(threadId, resolvers)
        })
      } finally {
        const count = (waiting.get(threadId) ?? 1) - 1
        if (count === 0) waiting.delete(threadId)
        else waiting.set(threadId, count)
        refreshWaiting(threadId)
      }
    }

    const ensureEnabled = () => {
      if (!enabled) throw new DevicesError({ message: "Devices are off. Turn them on in Settings > Experimental." })
    }

    const attempt = <A>(work: () => Promise<A>) =>
      Effect.tryPromise({
        try: async () => {
          ensureEnabled()
          return await work()
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
        const devices = (
          await Promise.all([
            ios.kind === "ready" ? options.drivers.ios.list() : [],
            android.kind === "ready" ? options.drivers.android.list() : [],
          ])
        ).flat()
        return {
          ios,
          android,
          simslim,
          devices: devices.map((device) => ({ ...device, ownerThreadId: owners.get(device.id) ?? null })),
        }
      })

    const detachNow = async (threadId: string) => {
      const row = await readRow(threadId)
      const state = current(threadId)
      const deviceId = state.phase === "ready" ? state.device.id : (row?.deviceId ?? null)
      setState(threadId, NONE)
      await deleteRow(threadId)
      if (deviceId === null) return
      const stillUsed = [...states.values()].some((other) => other.phase === "ready" && other.device.id === deviceId)
      const live = links.get(deviceId)
      if (live && !stillUsed) closeLive(live)
      if (row?.owned) await driverOf(deviceId).remove(deviceId)
    }

    const releaseThread = (threadId: string) =>
      Effect.tryPromise(() => detachNow(threadId)).pipe(
        Effect.catchCause((cause) => Effect.logWarning("could not release the thread's device", cause)),
      )

    const act = (threadId: string, commands: ReadonlyArray<DeviceCommand>) =>
      attempt(async (): Promise<AgentInput> => {
        const { state } = await readyDevice(threadId, true)
        if (state.control === "user") {
          await waitForHandBack(threadId)
          return "handedBack"
        }
        await send(threadId, commands)
        return "done"
      })

    const screenshot = (threadId: string) =>
      attempt(async () => {
        const { live } = await readyDevice(threadId, true)
        const frame = live.latest ?? (await newestFrame(live, 0, 5000))
        if (!frame) throw new DevicesError({ message: "The device has not sent a frame yet. Try again in a moment." })
        return frame
      })

    const pick = (input: RpcRequest<"device.pick">) =>
      attempt(async (): Promise<PickedDeviceElement | null> => {
        const { state } = await readyDevice(input.threadId, false)
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
      for (const live of links.values()) if (Date.now() - live.lease > expiry) closeLive(live)
    })
    // A sweep rather than a call from archive, so archives from any path, and ones before a crash, converge.
    const releaseArchived = sql<{ threadId: string }>`
      SELECT thread_device.thread_id FROM thread_device JOIN thread ON thread.id = thread_device.thread_id
      WHERE thread.status = 'archived'
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
      get: (threadId) => attempt(() => ensure(threadId, false)),
      attach: (threadId, deviceId) =>
        attempt(async () => {
          const row = await readRow(threadId)
          if (row?.deviceId !== deviceId) {
            if (row) await detachNow(threadId)
            await writeRow(threadId, { deviceId, owned: false })
          }
          return attachExisting(threadId, deviceId)
        }),
      create: (threadId) =>
        attempt(async () => {
          if ((await readRow(threadId))?.owned) return ensure(threadId, false)
          if (await readRow(threadId)) await detachNow(threadId)
          return createFor(threadId)
        }),
      detach: (threadId) => attempt(() => detachNow(threadId)),
      frame: (input) =>
        attempt(async () => {
          if (!input.visible) return { frame: null }
          const { live } = await readyDevice(input.threadId, false)
          live.lease = Date.now()
          await live.link
          return { frame: await newestFrame(live, input.after, FRAME_WAIT_MS) }
        }),
      command: (input) =>
        attempt(async () => {
          setControl(input.threadId, "user")
          await send(input.threadId, input.commands)
        }),
      control: (threadId, control) => attempt(async () => setControl(threadId, control)),
      pick,
      act,
      screenshot,
      describe: (threadId) =>
        attempt(async () => {
          const { state } = await readyDevice(threadId, true)
          return driverOf(state.device.id).describe(state.device.id)
        }),
      launch: (threadId, app) =>
        attempt(async () => {
          const { state } = await readyDevice(threadId, true)
          await driverOf(state.device.id).launch(state.device.id, app)
        }),
    })
  })

export const devicesLayer = (options: DevicesOptions) => Layer.effect(Devices, make(options))
