import { randomUUID } from "node:crypto"
import { Context, Effect, Layer, Schedule, Schema, Stream } from "effect"
import { type RpcMethod, RpcMethods, type RpcRequest, type RpcResponse } from "../../../shared/contract.ts"
import type { DeviceFrame, DeviceHost, DeviceId, DevicePlatform } from "../../../shared/device.ts"
import { devicePlatformOf } from "../../../shared/device.ts"
import type { DeviceHubLink } from "../../../shared/domain.ts"
import { Environments } from "../Environments.ts"
import { Settings } from "../Settings.ts"
import { devicesLayer } from "./Devices.ts"
import { DeviceError, type DeviceLink, type DevicePlatformDriver, type Frame } from "./platform.ts"

export class DeviceHubError extends Schema.TaggedError<DeviceHubError>()("DeviceHubError", {
  message: Schema.String,
}) {}

export type Drivers = Record<DevicePlatform, DevicePlatformDriver>

type HostMethod = Extract<RpcMethod, `deviceHost.${string}`>

export type HostHandlers = {
  readonly [M in HostMethod]: (payload: RpcRequest<M>) => Effect.Effect<RpcResponse<M>, DeviceHubError>
}

export class DeviceHub extends Context.Service<
  DeviceHub,
  {
    readonly drivers: Drivers
    readonly simslimAvailable: () => Promise<boolean>
    readonly host: HostHandlers
    readonly status: Effect.Effect<DeviceHubLink | null, DeviceHubError>
    readonly link: (pairingUrl: string) => Effect.Effect<DeviceHubLink, DeviceHubError>
    readonly unlink: Effect.Effect<void, DeviceHubError>
  }
>()("hinacode/DeviceHub") {}

export interface DeviceHubOptions {
  readonly drivers: Drivers
  readonly simslimAvailable: () => Promise<boolean>
  readonly streamLeaseMs?: number
}

interface Screen {
  latest: DeviceFrame | null
  ended: string | null
  lease: number
  readonly waiters: Set<() => void>
}

interface HostStream extends Screen {
  readonly link: DeviceLink
}

const FRAME_WAIT_MS = 1000
const HOST_LIST_TTL_MS = 1000
const messageOf = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause))
const hubError = (cause: unknown) => new DeviceHubError({ message: messageOf(cause) })

const encodeFrame = (sequence: number, frame: Frame): DeviceFrame => ({
  ...frame,
  sequence,
  data: frame.data.toString("base64"),
})

const decodeFrame = ({ sequence: _sequence, data, ...rest }: DeviceFrame): Frame => ({
  ...rest,
  data: Buffer.from(data, "base64"),
})

const wake = (stream: Screen) => {
  const waiters = [...stream.waiters]
  stream.waiters.clear()
  waiters.forEach((resolve) => resolve())
}

const attempt = <A>(work: () => Promise<A>) => Effect.tryPromise({ try: work, catch: hubError })

const serveLocalDevices = (local: Drivers, simslimAvailable: () => Promise<boolean>, leaseMs: number) => {
  const streams = new Map<string, HostStream>()
  let sequence = 0

  const closeStream = (streamId: string) => {
    const stream = streams.get(streamId)
    if (stream === undefined) return
    streams.delete(streamId)
    stream.ended ??= "The device stream closed."
    wake(stream)
    void stream.link.close().catch(() => undefined)
  }

  const nextFrame = async (stream: HostStream, after: number) => {
    if (stream.ended === null && !(stream.latest && stream.latest.sequence > after)) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          stream.waiters.delete(done)
          resolve()
        }, FRAME_WAIT_MS)
        const done = () => {
          clearTimeout(timer)
          resolve()
        }
        stream.waiters.add(done)
      })
    }
    const frame = stream.latest && stream.latest.sequence > after ? stream.latest : null
    return { frame, ended: frame === null ? stream.ended : null }
  }

  const driverOf = (deviceId: DeviceId) => local[devicePlatformOf(deviceId)]

  const handlers: HostHandlers = {
    "deviceHost.list": () =>
      attempt(async (): Promise<DeviceHost> => {
        const [ios, android, simslim] = await Promise.all([
          local.ios.support(),
          local.android.support(),
          simslimAvailable(),
        ])
        const [iosDevices, androidDevices, models] = await Promise.all([
          ios.kind === "ready" ? local.ios.list() : [],
          android.kind === "ready" ? local.android.list() : [],
          ios.kind === "ready" ? local.ios.models() : [],
        ])
        return { ios, android, simslim, devices: [...iosDevices, ...androidDevices], models }
      }),
    "deviceHost.boot": ({ deviceId }) => attempt(() => driverOf(deviceId).boot(deviceId, () => undefined)),
    "deviceHost.create": ({ name, model }) =>
      attempt(async () => ({
        deviceId: await local.ios.create(
          name,
          model,
          () => undefined,
          () => Promise.resolve(),
        ),
      })),
    "deviceHost.remove": ({ deviceId }) => attempt(() => driverOf(deviceId).remove(deviceId)),
    "deviceHost.screenshot": ({ deviceId }) =>
      attempt(async () => ({ data: (await driverOf(deviceId).screenshot(deviceId)).toString("base64") })),
    "deviceHost.describe": ({ deviceId }) => attempt(() => driverOf(deviceId).describe(deviceId)),
    "deviceHost.launch": ({ deviceId, app }) => attempt(() => driverOf(deviceId).launch(deviceId, app)),
    "deviceHost.open": ({ deviceId }) =>
      attempt(async () => {
        const streamId = randomUUID()
        const screen: Screen = { latest: null, ended: null, lease: Date.now(), waiters: new Set() }
        const link = await driverOf(deviceId).connect(deviceId, (frame) => {
          screen.latest = encodeFrame(++sequence, frame)
          wake(screen)
        })
        streams.set(streamId, Object.assign(screen, { link }))
        void link.ended.then((reason) => {
          screen.ended ??= reason
          wake(screen)
        })
        return { streamId, screen: link.screen }
      }),
    "deviceHost.frame": ({ streamId, after }) =>
      attempt(async () => {
        const stream = streams.get(streamId)
        if (stream === undefined) return { frame: null, ended: "The device stream closed." }
        stream.lease = Date.now()
        return nextFrame(stream, after)
      }),
    "deviceHost.send": ({ streamId, commands }) =>
      attempt(async () => {
        const stream = streams.get(streamId)
        if (stream === undefined) throw new DeviceError("The device stream closed.")
        stream.lease = Date.now()
        await stream.link.send(commands)
      }),
    "deviceHost.close": ({ streamId }) => Effect.sync(() => closeStream(streamId)),
  }

  const expireStreams = Effect.sync(() => {
    for (const [streamId, stream] of streams) if (Date.now() - stream.lease > leaseMs) closeStream(streamId)
  })
  const closeAll = Effect.sync(() => [...streams.keys()].forEach(closeStream))
  return { handlers, expireStreams, closeAll }
}

const make = (options: DeviceHubOptions) =>
  Effect.gen(function* () {
    const environments = yield* Environments
    const settings = yield* Settings
    const scope = yield* Effect.scope
    const local = options.drivers

    let hubId = yield* settings.get.pipe(
      Effect.map((value) => value.experimental.deviceHub),
      Effect.orElseSucceed(() => null),
    )
    yield* (yield* settings.changes).pipe(
      Stream.runForEach((value) =>
        Effect.sync(() => {
          hubId = value.experimental.deviceHub
        }),
      ),
      Effect.forkIn(scope),
    )

    const callHub = async <M extends HostMethod>(method: M, payload: RpcRequest<M>): Promise<RpcResponse<M>> => {
      const target = hubId
      if (target === null) throw new DeviceError("No device hub is linked.")
      const envelope = await Effect.runPromise(environments.forward(target, { method, payload }))
      if ("error" in envelope) throw new DeviceError(`The device hub answered: ${envelope.error.message}`)
      return Schema.decodeUnknownPromise(RpcMethods[method].response)(envelope.result) as Promise<RpcResponse<M>>
    }

    let hostList: { readonly at: number; readonly hub: string; readonly answer: Promise<DeviceHost> } | null = null
    const hubDevices = () => {
      const now = Date.now()
      if (hostList === null || hostList.hub !== hubId || now - hostList.at > HOST_LIST_TTL_MS) {
        const answer = callHub("deviceHost.list", undefined)
        hostList = { at: now, hub: hubId ?? "", answer }
        answer.catch(() => {
          if (hostList?.answer === answer) hostList = null
        })
      }
      return hostList.answer
    }

    const connectThroughHub = async (deviceId: DeviceId, onFrame: (frame: Frame) => void): Promise<DeviceLink> => {
      const { streamId, screen } = await callHub("deviceHost.open", { deviceId })
      const stream = { closed: false, after: 0 }
      const poll = async () => {
        while (!stream.closed) {
          const { frame, ended } = await callHub("deviceHost.frame", { streamId, after: stream.after })
          if (ended !== null) return ended
          if (frame === null || stream.closed) continue
          stream.after = frame.sequence
          onFrame(decodeFrame(frame))
        }
        return "The device stream closed."
      }
      return {
        screen,
        send: (commands) => callHub("deviceHost.send", { streamId, commands }),
        ended: poll().catch((cause: unknown) => `Lost the device hub: ${messageOf(cause)}`),
        close: async () => {
          stream.closed = true
          await callHub("deviceHost.close", { streamId }).catch(() => undefined)
        },
      }
    }

    const remote = (platform: DevicePlatform): DevicePlatformDriver => ({
      support: async () => (await hubDevices())[platform],
      list: async () => (await hubDevices()).devices.filter((device) => device.platform === platform),
      models: async () => (platform === "ios" ? (await hubDevices()).models : []),
      boot: (deviceId, onStep) => {
        onStep("booting")
        return callHub("deviceHost.boot", { deviceId })
      },
      create: async (name, model, _onStep, onCreated) => {
        const { deviceId } = await callHub("deviceHost.create", { name, model })
        await onCreated(deviceId)
        return deviceId
      },
      remove: (deviceId) => callHub("deviceHost.remove", { deviceId }),
      connect: connectThroughHub,
      screenshot: async (deviceId) =>
        Buffer.from((await callHub("deviceHost.screenshot", { deviceId })).data, "base64"),
      describe: (deviceId) => callHub("deviceHost.describe", { deviceId }),
      launch: (deviceId, app) => callHub("deviceHost.launch", { deviceId, app }),
    })

    const remoteDrivers: Drivers = { ios: remote("ios"), android: remote("android") }
    const pick = (platform: DevicePlatform) => (hubId === null ? local : remoteDrivers)[platform]
    const switching = (platform: DevicePlatform): DevicePlatformDriver => ({
      support: () => pick(platform).support(),
      list: () => pick(platform).list(),
      models: () => pick(platform).models(),
      boot: (deviceId, onStep) => pick(platform).boot(deviceId, onStep),
      create: (name, model, onStep, onCreated) => pick(platform).create(name, model, onStep, onCreated),
      remove: (deviceId) => pick(platform).remove(deviceId),
      connect: (deviceId, onFrame) => pick(platform).connect(deviceId, onFrame),
      screenshot: (deviceId) => pick(platform).screenshot(deviceId),
      describe: (deviceId) => pick(platform).describe(deviceId),
      launch: (deviceId, app) => pick(platform).launch(deviceId, app),
    })

    const served = serveLocalDevices(local, options.simslimAvailable, options.streamLeaseMs ?? 15000)
    yield* served.expireStreams.pipe(Effect.schedule(Schedule.spaced(5000)), Effect.forkIn(scope))
    yield* Effect.addFinalizer(() => served.closeAll)

    const status = Effect.gen(function* () {
      const target = hubId
      if (target === null) return null
      const { clouds } = yield* environments.list.pipe(Effect.mapError(hubError))
      const cloud = clouds.find((each) => each.id === target)
      return cloud === undefined
        ? { environmentId: target, name: target, status: "offline" as const }
        : { environmentId: cloud.id, name: cloud.name, status: cloud.status }
    })

    const setHub = (next: string | null) =>
      Effect.flatMap(settings.get, (current) =>
        settings.set({ experimental: { ...current.experimental, deviceHub: next } }),
      ).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            hubId = next
          }),
        ),
        Effect.mapError(hubError),
      )

    return DeviceHub.of({
      drivers: { ios: switching("ios"), android: switching("android") },
      simslimAvailable: async () => (hubId === null ? options.simslimAvailable() : (await hubDevices()).simslim),
      host: served.handlers,
      status,
      link: (pairingUrl) =>
        environments.add({ name: "", pairingUrl }).pipe(
          Effect.mapError(hubError),
          Effect.flatMap((environment) => setHub(environment.id)),
          Effect.andThen(status),
          Effect.flatMap((link) =>
            link === null ? Effect.fail(hubError("The device hub did not link.")) : Effect.succeed(link),
          ),
        ),
      unlink: setHub(null).pipe(Effect.asVoid),
    })
  })

export const layer = (options: DeviceHubOptions) => Layer.effect(DeviceHub, make(options))

export const devicesThroughHubLayer = (options: DeviceHubOptions) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const hub = yield* DeviceHub
      return devicesLayer({ drivers: hub.drivers, simslimAvailable: hub.simslimAvailable })
    }),
  ).pipe(Layer.provideMerge(layer(options)))
