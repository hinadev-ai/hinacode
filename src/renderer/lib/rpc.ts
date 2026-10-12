import { Effect, Schedule, Schema, Stream } from "effect"
import { Atom } from "effect/reactivity"
import type { ProviderId } from "../../shared/agent.ts"
import { PushEvent, type RpcMethod, RpcMethods, type RpcRequest, type RpcResponse } from "../../shared/contract.ts"
import type { Thread } from "../../shared/domain.ts"

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

export const cloneProjectAtom = Atom.fn((input: RpcRequest<"projects.clone">) =>
  call("projects.clone", input).pipe(Effect.tap(() => Atom.refresh(projectsAtom))),
)

export const updateProjectAtom = Atom.fn((input: RpcRequest<"projects.update">) =>
  call("projects.update", input).pipe(Effect.tap(() => Atom.refresh(projectsAtom))),
)

export const settingsAtom = Atom.make(call("settings.get", undefined)).pipe(Atom.keepAlive)

export const updateSettingsAtom = Atom.fn((patch: RpcRequest<"settings.set">) =>
  call("settings.set", patch).pipe(Effect.tap(() => Atom.refresh(settingsAtom))),
)

export const modelsAtom = Atom.family((provider: ProviderId) =>
  Atom.make(call("models.list", { provider })).pipe(Atom.keepAlive),
)

/**
 * Identifies a thread together with its agent and workspace, since switching either changes what the
 * composer can complete. Key for `commandsAtom` and `filesAtom`.
 */
export const completionKey = (thread: Pick<Thread, "id" | "provider" | "worktreeId">) =>
  [thread.id, thread.provider, thread.worktreeId ?? ""].join("\n")
const threadIdOf = (key: string) => key.split("\n")[0] ?? ""

export const commandsAtom = Atom.family((key: string) =>
  Atom.make(call("commands.list", { threadId: threadIdOf(key) })),
)

export const filesAtom = Atom.family((key: string) => Atom.make(call("files.list", { threadId: threadIdOf(key) })))

/** The branch checked out in the project root. Asked again when the window comes back, in case it changed. */
export const currentBranchAtom = Atom.family((projectId: string) =>
  Atom.make(call("projects.currentBranch", { id: projectId })).pipe(Atom.makeRefreshOnSignal(windowReturnSignal)),
)

/** Keyed by `${threadId}\n${scope}`. Asked again when the window comes back, since agents edit files meanwhile. */
export const threadChangesAtom = Atom.family((key: string) => {
  const [threadId = "", scope] = key.split("\n")
  return Atom.make(call("threads.changes", { threadId, scope: scope === "turn" ? "turn" : "worktree" })).pipe(
    Atom.makeRefreshOnSignal(windowReturnSignal),
  )
})

/**
 * Bumps when the window comes back into view or regains focus. Effect's `windowFocusSignal` only
 * listens for `visibilitychange`, which never fires when switching between visible desktop windows.
 */
const windowReturnSignal = Atom.readable((get) => {
  let count = 0
  const bump = () => {
    if (document.visibilityState === "visible") get.setSelf(++count)
  }
  window.addEventListener("focus", bump)
  document.addEventListener("visibilitychange", bump)
  get.addFinalizer(() => {
    window.removeEventListener("focus", bump)
    document.removeEventListener("visibilitychange", bump)
  })
  return count
})

/**
 * The pull request for a worktree's branch, or null when there is none. Re-asked every minute while
 * shown and when the window comes back, so a merge on GitHub shows up. A null worktree id resolves
 * to null without asking `gh`.
 */
export const branchPullRequestAtom = Atom.family((worktreeId: string | null) =>
  worktreeId
    ? Atom.make(call("worktrees.pullRequest", { id: worktreeId })).pipe(
        Atom.withRefresh("60 seconds"),
        Atom.makeRefreshOnSignal(windowReturnSignal),
      )
    : Atom.make(Effect.succeed(null)),
)

/** A linked pull request's status, refreshed like `branchPullRequestAtom`. */
export const pullRequestStatusAtom = Atom.family((url: string) =>
  Atom.make(call("github.pullRequest", { url })).pipe(
    Atom.withRefresh("60 seconds"),
    Atom.makeRefreshOnSignal(windowReturnSignal),
  ),
)

/** Everything the PR tab shows about one pull request, refreshed like `pullRequestStatusAtom`. */
export const pullRequestDetailAtom = Atom.family((url: string) =>
  Atom.make(call("github.pullRequestDetail", { url })).pipe(
    Atom.withRefresh("60 seconds"),
    Atom.makeRefreshOnSignal(windowReturnSignal),
  ),
)

/**
 * Whether `gh` is signed in. Kept for 12 hours after the last screen showing it closes, since asking `gh`
 * is slow and the answer rarely changes. Settings' Recheck asks again at once.
 */
export const gitHubAuthAtom = Atom.make(call("github.auth", undefined)).pipe(Atom.setIdleTTL("12 hours"))

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
