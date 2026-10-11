import { Effect, Schema } from "effect"
import { Atom } from "effect/reactivity"
import type { ProviderId } from "../../shared/agent.ts"
import { PushEvent, type RpcMethod, RpcMethods, type RpcRequest, type RpcResponse } from "../../shared/contract.ts"

export class RpcError extends Schema.TaggedError<RpcError>()("RpcError", {
  tag: Schema.String,
  message: Schema.String,
}) {}

/** Calls the main process. Fails with `RpcError` carrying the handler's error tag and message. */
export const call = <M extends RpcMethod>(
  method: M,
  payload: RpcRequest<M>,
): Effect.Effect<RpcResponse<M>, RpcError> => {
  const spec = RpcMethods[method]
  const encodeRequest = Schema.encodeEffect(spec.request)
  const decodeResponse = Schema.decodeUnknownEffect(spec.response)
  return Effect.gen(function* () {
    const encoded = yield* encodeRequest(payload)
    const envelope = yield* Effect.promise(() => window.kkcode.rpc(method, encoded))
    if ("error" in envelope) return yield* new RpcError(envelope.error)
    return yield* decodeResponse(envelope.result)
  }).pipe(
    Effect.catchTag("SchemaError", (error) => Effect.fail(new RpcError({ tag: error._tag, message: error.message }))),
  )
}

export const callPromise = <M extends RpcMethod>(method: M, payload: RpcRequest<M>) =>
  Effect.runPromise(call(method, payload))

const decodePushEvent = Schema.decodeUnknownSync(PushEvent)

export const onPushEvent = (listener: (event: PushEvent) => void) =>
  window.kkcode.onEvent((raw) => listener(decodePushEvent(raw)))

export const projectsAtom = Atom.make(call("projects.list", undefined)).pipe(Atom.keepAlive)

export const createProjectAtom = Atom.fn((input: RpcRequest<"projects.create">) =>
  call("projects.create", input).pipe(Effect.tap(() => Atom.refresh(projectsAtom))),
)

export const settingsAtom = Atom.make(call("settings.get", undefined)).pipe(Atom.keepAlive)

export const updateSettingsAtom = Atom.fn((patch: RpcRequest<"settings.set">) =>
  call("settings.set", patch).pipe(Effect.tap(() => Atom.refresh(settingsAtom))),
)

export const modelsAtom = Atom.family((provider: ProviderId) => Atom.make(call("models.list", { provider })))

export const secretStoredAtom = Atom.family((name: string) => Atom.make(call("secrets.has", { name })))
