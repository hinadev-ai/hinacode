import { Effect, Schema } from "effect"
import { type RpcMethod, RpcMethods, type RpcRequest, type RpcResponse } from "../../../shared/contract.ts"
import { RemoteAccess } from "../../remote/access.ts"
import { Environments } from "../Environments.ts"
import { Settings } from "../Settings.ts"

export class DeviceHubError extends Schema.TaggedError<DeviceHubError>()("DeviceHubError", {
  message: Schema.String,
}) {}

export const deviceHub: Effect.Effect<string | undefined, never, Settings> = Settings.use(
  (settings) => settings.get,
).pipe(
  Effect.map((value) => value.experimental.devicesOn ?? undefined),
  Effect.orElseSucceed(() => undefined),
)

const TAKES_CLIENT: ReadonlySet<RpcMethod> = new Set([
  "device.attach",
  "device.create",
  "device.act",
  "device.look",
  "device.describe",
  "device.launch",
  "device.logs",
  "device.install.begin",
])

export const asHubClient = (method: RpcMethod, payload: unknown): Effect.Effect<unknown, never, RemoteAccess> =>
  TAKES_CLIENT.has(method) && typeof payload === "object" && payload !== null
    ? RemoteAccess.use(({ identity }) =>
        Effect.succeed({ ...payload, client: { id: identity.id, name: identity.name } }),
      )
    : Effect.succeed(payload)

export const forwardToHub = (hub: string, method: RpcMethod, payload: unknown) =>
  asHubClient(method, payload).pipe(
    Effect.flatMap((forwarded) =>
      Environments.use((environments) => environments.forward(hub, { method, payload: forwarded })),
    ),
  )

const reachable = (hub: string) =>
  Environments.use((environments) => environments.list).pipe(
    Effect.orElseSucceed(() => ({ clouds: [] })),
    Effect.flatMap(({ clouds }) => {
      const cloud = clouds.find((each) => each.id === hub)
      if (cloud === undefined) {
        return Effect.fail(
          new DeviceHubError({
            message:
              "The machine chosen to run devices is no longer paired. Pick another in Settings > Experimental > Run devices on.",
          }),
        )
      }
      return cloud.status === "offline"
        ? Effect.fail(
            new DeviceHubError({ message: `${cloud.name} is offline. Devices come back when it reconnects.` }),
          )
        : Effect.void
    }),
  )

export const callHub = <M extends RpcMethod>(
  hub: string,
  method: M,
  payload: RpcRequest<M>,
): Effect.Effect<RpcResponse<M>, DeviceHubError, RemoteAccess | Environments> =>
  reachable(hub).pipe(
    Effect.andThen(Schema.encodeUnknownEffect(RpcMethods[method].request as Schema.Top)(payload)),
    Effect.flatMap((encoded) => forwardToHub(hub, method, encoded)),
    Effect.flatMap((envelope): Effect.Effect<unknown, DeviceHubError | Schema.SchemaError> =>
      "error" in envelope
        ? Effect.fail(new DeviceHubError({ message: envelope.error.message }))
        : Schema.decodeUnknownEffect(RpcMethods[method].response as Schema.Codec<unknown, unknown>)(envelope.result),
    ),
    Effect.mapError((error) =>
      error instanceof DeviceHubError
        ? error
        : new DeviceHubError({ message: `The device hub answered something unexpected: ${error.message}` }),
    ),
  ) as Effect.Effect<RpcResponse<M>, DeviceHubError, RemoteAccess | Environments>
