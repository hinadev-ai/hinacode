import { Effect, Layer, Schema, Stream } from "effect"
import { type RpcMethod, RpcMethods, type RpcRequest, type RpcResponse } from "../../../shared/contract.ts"
import { Environments } from "../Environments.ts"
import { PushBroadcast, releasedThreadOf } from "../Events.ts"
import { Settings } from "../Settings.ts"
import { Devices, DevicesError } from "./Devices.ts"

type DeviceMethod = Extract<RpcMethod, `device.${string}` | "devices.list">

export const devicesHubLayer = Layer.effect(
  Devices,
  Effect.gen(function* () {
    const local = yield* Devices
    const environments = yield* Environments
    const settings = yield* Settings
    const broadcast = yield* PushBroadcast
    const scope = yield* Effect.scope
    const runFork = Effect.runForkWith(yield* Effect.context<never>())

    let hub = yield* settings.get.pipe(
      Effect.map((value) => value.experimental.devicesHub),
      Effect.orElseSucceed(() => null),
    )
    yield* (yield* settings.changes).pipe(
      Stream.runForEach((value) =>
        Effect.sync(() => {
          hub = value.experimental.devicesHub
        }),
      ),
      Effect.forkIn(scope),
    )

    const paired = (environmentId: string) =>
      environments.list.pipe(
        Effect.map(({ clouds }) => clouds.some((cloud) => cloud.id === environmentId)),
        Effect.orElseSucceed(() => true),
      )

    const forward = <M extends DeviceMethod, E>(
      environmentId: string,
      method: M,
      payload: RpcRequest<M>,
      locally: Effect.Effect<RpcResponse<M>, E>,
    ): Effect.Effect<RpcResponse<M>, E | DevicesError> =>
      Effect.gen(function* () {
        const envelope = yield* environments.forward(environmentId, { method, payload })
        if (!("error" in envelope)) {
          return yield* (
            Schema.decodeUnknownEffect(RpcMethods[method].response)(envelope.result) as Effect.Effect<
              RpcResponse<M>,
              Schema.SchemaError
            >
          ).pipe(
            Effect.mapError(
              (error) => new DevicesError({ message: `Unexpected answer to ${method}: ${error.message}` }),
            ),
          )
        }
        if (envelope.error.tag === "NotFoundError" && !(yield* paired(environmentId))) return yield* locally
        return yield* new DevicesError({ message: envelope.error.message })
      })

    const route = <M extends DeviceMethod, E>(
      method: M,
      payload: RpcRequest<M>,
      locally: Effect.Effect<RpcResponse<M>, E>,
    ) => Effect.suspend(() => (hub === null ? locally : forward(hub, method, payload, locally)))

    const withDevice = (device: string | undefined) => (device === undefined ? {} : { device })

    yield* broadcast.subscribe((event) => {
      const threadId = releasedThreadOf(event)
      if (threadId === undefined || hub === null) return
      runFork(
        forward(hub, "device.release", { threadId }, Effect.void).pipe(
          Effect.catchCause((cause) => Effect.logWarning("could not release a thread's devices on the hub", cause)),
        ),
      )
    })

    return Devices.of({
      enabled: local.enabled,
      list: (input) => route("devices.list", input, local.list(input)),
      get: (threadId) => route("device.get", { threadId }, local.get(threadId)),
      attach: (threadId, deviceId) => route("device.attach", { threadId, deviceId }, local.attach(threadId, deviceId)),
      create: (threadId, model) =>
        route("device.create", model === undefined ? { threadId } : { threadId, model }, local.create(threadId, model)),
      detach: (threadId, deviceId) => route("device.detach", { threadId, deviceId }, local.detach(threadId, deviceId)),
      delete: (threadId, deviceId) => route("device.delete", { threadId, deviceId }, local.delete(threadId, deviceId)),
      shutdown: (threadId, deviceId) =>
        route("device.shutdown", { threadId, deviceId }, local.shutdown(threadId, deviceId)),
      frame: (input) => route("device.frame", input, local.frame(input)),
      command: (input) => route("device.command", input, local.command(input)),
      control: (threadId, deviceId, control) =>
        route("device.control", { threadId, deviceId, control }, local.control(threadId, deviceId, control)),
      pick: (input) => route("device.pick", input, local.pick(input)),
      act: (threadId, device, action, steps) =>
        route(
          "device.act",
          { threadId, ...withDevice(device), action, ...steps },
          local.act(threadId, device, action, steps),
        ),
      screenshot: (threadId, device) =>
        route("device.screenshot", { threadId, ...withDevice(device) }, local.screenshot(threadId, device)),
      describe: (threadId, device) =>
        route("device.describe", { threadId, ...withDevice(device) }, local.describe(threadId, device)),
      launch: (threadId, device, app) =>
        route("device.launch", { threadId, ...withDevice(device), app }, local.launch(threadId, device, app)),
      release: (threadId) =>
        route("device.release", { threadId }, local.release(threadId)).pipe(
          Effect.catchTag("DevicesError", (error) =>
            Effect.logWarning("could not release a thread's devices on the hub", error.message),
          ),
        ),
    })
  }),
)
