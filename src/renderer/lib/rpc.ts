import { Effect, Schedule, Schema, Stream } from "effect"
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

export const modelsAtom = Atom.family((provider: ProviderId) =>
  Atom.make(call("models.list", { provider })).pipe(Atom.keepAlive),
)

export const currentBranchAtom = Atom.family((projectId: string) =>
  Atom.make(call("projects.currentBranch", { id: projectId })),
)

export const worktreeChangesAtom = Atom.family((worktreeId: string) =>
  Atom.make(call("worktrees.changes", { id: worktreeId })),
)

export const pullRequestAtom = Atom.family((worktreeId: string) =>
  Atom.make(call("worktrees.mergedState", { id: worktreeId })),
)

export const secretStoredAtom = Atom.family((name: string) => Atom.make(call("secrets.has", { name })))

/** Re-lists the thread's open ports every 2s while something subscribes. */
export const threadPortsAtom = Atom.family((threadId: string) =>
  Atom.make(Stream.fromEffectSchedule(call("ports.list", { threadId }), Schedule.spaced("2 seconds"))),
)

const onAutomationRun = (listener: (automationId: string) => void) =>
  onPushEvent((event) => event.type === "automation.run" && listener(event.run.automationId))

/** Re-lists every 15s while subscribed so poll times stay current; a recorded run refreshes it at once. */
export const automationsAtom = Atom.make((get) => {
  get.addFinalizer(onAutomationRun(() => get.refreshSelf()))
  return Stream.fromEffectSchedule(call("automations.list", undefined), Schedule.spaced("15 seconds"))
})

export const automationRunsAtom = Atom.family((automationId: string) =>
  Atom.make((get) => {
    get.addFinalizer(onAutomationRun((id) => id === automationId && get.refreshSelf()))
    return call("automations.runs", { id: automationId, limit: 20 })
  }),
)

/** Recomputed when settings change, since the URL follows the listener's bind host and port. */
export const webhookUrlAtom = Atom.family((automationId: string) =>
  Atom.make((get) => {
    get(settingsAtom)
    return call("automations.webhookUrl", { id: automationId })
  }),
)
