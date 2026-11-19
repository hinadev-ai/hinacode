import { Effect, Layer, Option, Schema } from "effect"
import { type RpcMethod, RpcMethods } from "../../shared/contract.ts"
import { routes } from "../../shared/routes.ts"
import { type AppServices, type DesktopCalls, dispatch, type HandlerError, RpcCall } from "../rpc.ts"
import { inlineSource } from "../services/Attachments.ts"
import { Environments } from "../services/Environments.ts"
import { deviceHub, forwardToHub } from "../services/devices/hub.ts"
import { Threads } from "../services/Threads.ts"

const WindowCall = Schema.Struct({ ...RpcCall.fields, environment: Schema.optional(Schema.String) })
const decodeWindowCall = Schema.decodeUnknownOption(WindowCall)
const decodeRpcCall = Schema.decodeUnknownOption(RpcCall)

const payloadId = (payload: unknown, key: string) => {
  const id = typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>)[key] : undefined
  return typeof id === "string" ? id : undefined
}

const inlineLocalAttachment = (method: RpcMethod, payload: unknown): Effect.Effect<unknown, HandlerError> =>
  method !== "attachments.stage"
    ? Effect.succeed(payload)
    : Schema.decodeUnknownEffect(RpcMethods[method].request)(payload).pipe(
        Effect.flatMap((request) =>
          "path" in request.source
            ? Effect.map(inlineSource(request.source.path), (source) => ({ ...request, source }))
            : Effect.succeed(request),
        ),
      )

const isOwnThread = (threadId: string) =>
  Threads.use((threads) => threads.get(threadId)).pipe(
    Effect.as(true),
    Effect.orElseSucceed(() => false),
  )

const deviceHubFor = (method: RpcMethod, payload: unknown) =>
  Effect.gen(function* () {
    const where = routes[method]
    if (where.to !== "owner" || where.orElse !== "deviceHub") return undefined
    const threadId = payloadId(payload, where.key)
    if (threadId === undefined) return undefined
    const hub = yield* deviceHub
    if (hub === undefined) return undefined
    return (yield* isOwnThread(threadId)) ? hub : undefined
  })

export const dispatchHere = (raw: unknown, desktop: DesktopCalls | null) =>
  Effect.gen(function* () {
    const decoded = Option.getOrUndefined(decodeRpcCall(raw))
    const hub = decoded === undefined ? undefined : yield* deviceHubFor(decoded.method, decoded.payload)
    if (decoded === undefined || hub === undefined) return yield* dispatch(raw, desktop)
    return yield* forwardToHub(hub, decoded.method, decoded.payload)
  })

export const route = (raw: unknown, desktop: DesktopCalls | null) =>
  Effect.gen(function* () {
    const decoded = Option.getOrUndefined(decodeWindowCall(raw))
    if (decoded === undefined) return yield* dispatch(raw, desktop)
    const environments = yield* Environments
    const { method, payload, environment } = decoded
    const where = routes[method]
    const owned = where.to === "owner" ? payloadId(payload, where.key) : undefined
    const owner = where.to === "owner" && owned !== undefined ? environments.owner(where.entity, owned) : undefined
    const target = where.to === "named" ? environment : owner
    if (target !== undefined) {
      return yield* inlineLocalAttachment(method, payload).pipe(
        Effect.flatMap((forwarded) => environments.forward(target, { method, payload: forwarded })),
        Effect.catch((error) => Effect.succeed({ error: { tag: error._tag, message: error.message } })),
      )
    }
    if (where.to !== "all") return yield* dispatchHere(raw, desktop)
    const [local, clouds] = yield* Effect.all([dispatch(raw, desktop), environments.gather({ method, payload })], {
      concurrency: "unbounded",
    })
    if ("error" in local || !Array.isArray(local.result)) return local
    return { result: [...local.result, ...clouds] }
  })

export const answerAsksLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const services = yield* Effect.context<AppServices | Environments>()
    const environments = yield* Environments
    yield* environments.answerAsks((call) => route(call, null).pipe(Effect.provideContext(services)))
  }),
)
