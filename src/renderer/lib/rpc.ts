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

export const notificationPermissionAtom = Atom.make(call("notifications.permission", undefined))

export const updateSettingsAtom = Atom.fn((patch: RpcRequest<"settings.set">) =>
  call("settings.set", patch).pipe(Effect.tap(() => Atom.refresh(settingsAtom))),
)

export const modelsAtom = Atom.family((provider: ProviderId) =>
  Atom.make(call("models.list", { provider })).pipe(Atom.keepAlive),
)

/**
 * Who an account is signed in as, keyed by `accountKey`. Not kept alive, so reopening the Models tab picks
 * up a sign-in made in a terminal meanwhile.
 */
export const accountAtom = Atom.family((key: string) => {
  const [provider, accountId] = JSON.parse(key) as [ProviderId, string | null]
  return Atom.make(call("agents.account", { provider, accountId }))
})
/** `accountId` null is the CLI's own login. */
export const accountKey = (provider: ProviderId, accountId: string | null) => JSON.stringify([provider, accountId])

/** Accounts added in kkcode, of every agent. */
export const accountsAtom = Atom.make(call("accounts.list", undefined)).pipe(Atom.keepAlive)

export const createAccountAtom = Atom.fn((input: RpcRequest<"accounts.create">) =>
  call("accounts.create", input).pipe(Effect.tap(() => Atom.refresh(accountsAtom))),
)

export const renameAccountAtom = Atom.fn((input: RpcRequest<"accounts.rename">) =>
  call("accounts.rename", input).pipe(Effect.tap(() => Atom.refresh(accountsAtom))),
)

/** Removing the default account also clears it from the settings. */
export const deleteAccountAtom = Atom.fn((id: string) =>
  call("accounts.delete", { id }).pipe(
    Effect.tap(() => Atom.refresh(accountsAtom)),
    Effect.tap(() => Atom.refresh(settingsAtom)),
  ),
)

/**
 * Identifies a thread together with its agent, account and workspace, since switching any of them
 * changes what the composer can complete: user-level commands and skills live in the account's home.
 * Key for `commandsAtom` and `filesAtom`.
 */
export const completionKey = (thread: Pick<Thread, "id" | "provider" | "accountId" | "worktreeId">) =>
  [thread.id, thread.provider, thread.accountId ?? "", thread.worktreeId ?? ""].join("\n")
const threadIdOf = (key: string) => key.split("\n")[0] ?? ""

export const commandsAtom = Atom.family((key: string) =>
  Atom.make(call("commands.list", { threadId: threadIdOf(key) })),
)

export const filesAtom = Atom.family((key: string) => Atom.make(call("files.list", { threadId: threadIdOf(key) })))

/** The branch checked out in the project root. Asked again when the window comes back, in case it changed. */
export const projectIconAtom = Atom.family((projectId: string) =>
  Atom.make(call("projects.icon", { id: projectId })).pipe(Atom.keepAlive),
)

export const currentBranchAtom = Atom.family((projectId: string) =>
  Atom.make(call("projects.currentBranch", { id: projectId })).pipe(Atom.makeRefreshOnSignal(windowReturnSignal)),
)

/** Branches a new worktree can fork from. Asked again when the window comes back, in case one was made meanwhile. */
export const branchesAtom = Atom.family((projectId: string) =>
  Atom.make(call("projects.branches", { id: projectId })).pipe(Atom.makeRefreshOnSignal(windowReturnSignal)),
)

/** The repository's open pull requests, through `gh`. Asked again when the window comes back. */
export const pullRequestsAtom = Atom.family((projectId: string) =>
  Atom.make(call("projects.pullRequests", { id: projectId })).pipe(Atom.makeRefreshOnSignal(windowReturnSignal)),
)

export const defaultBranchAtom = Atom.family((projectId: string) =>
  Atom.make(call("projects.defaultBranch", { id: projectId })),
)

/** The start of the file `path` under `root`, keyed by `JSON.stringify([root, path])`. */
export const fileContentAtom = Atom.family((key: string) => {
  const [root, path] = JSON.parse(key) as [string, string]
  return Atom.make(call("fs.read", { root, path }))
})

/** Keyed by `${threadId}\n${scope}`. Asked again when the window comes back, since agents edit files meanwhile. */
export const threadChangesAtom = Atom.family((key: string) => {
  const [threadId = "", scope] = key.split("\n")
  return Atom.make(call("threads.changes", { threadId, scope: scope === "turn" ? "turn" : "worktree" })).pipe(
    Atom.makeRefreshOnSignal(windowReturnSignal),
  )
})

/** How many commits the git graph asks for, per checkout. Grows as the list scrolls to its end. */
export const gitLogLimitAtom = Atom.family((_root: string) => Atom.make(200))

/** Commits of the checkout at `root`. Asked again when that worktree's status changes. */
export const gitLogAtom = Atom.family((root: string) =>
  Atom.make((get) => {
    get.addFinalizer(
      onPushEvent((event) => event.type === "worktree.updated" && event.worktree.path === root && get.refreshSelf()),
    )
    return call("git.log", { root, limit: get(gitLogLimitAtom(root)) })
  }),
)

/** One commit's changes, keyed by `commitKey`. */
export const commitDiffAtom = Atom.family((key: string) => {
  const [root = "", hash = ""] = key.split("\n")
  return Atom.make(call("git.show", { root, hash }))
})
export const commitKey = (root: string, hash: string) => `${root}\n${hash}`

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
 * A `gh` lookup per key that outlives the screen showing it, since every `gh` call is a network round trip.
 * Showing a key again within 10 minutes renders the last answer at once and asks `gh` again only when that
 * answer is over 30 seconds old. While shown, it is re-asked every minute and when the window comes back,
 * so a merge on GitHub shows up.
 */
const gitHubLookup = <K, A>(lookup: (key: K) => Effect.Effect<A, RpcError>) => {
  // Its own family: the wrapper below is dropped on unmount, and a family only holds its atoms weakly.
  const cached = Atom.family((key: K) => Atom.make(lookup(key)).pipe(Atom.setIdleTTL("10 minutes")))
  return Atom.family((key: K) =>
    cached(key).pipe(
      Atom.swr({ staleTime: "30 seconds", revalidateOnFocus: true, focusSignal: windowReturnSignal }),
      Atom.withRefresh("60 seconds"),
    ),
  )
}

/** The pull request for a worktree's branch, or null when there is none. A null worktree id never asks `gh`. */
export const branchPullRequestAtom = gitHubLookup((worktreeId: string | null) =>
  worktreeId ? call("worktrees.pullRequest", { id: worktreeId }) : Effect.succeed(null),
)

/** A linked pull request's status. */
export const pullRequestStatusAtom = gitHubLookup((url: string) => call("github.pullRequest", { url }))

/** Everything the PR tab shows about one pull request. */
export const pullRequestDetailAtom = gitHubLookup((url: string) => call("github.pullRequestDetail", { url }))

/**
 * Whether `gh` is signed in. Kept for 12 hours after the last screen showing it closes, since asking `gh`
 * is slow and the answer rarely changes. Settings' Recheck asks again at once.
 */
export const gitHubAuthAtom = Atom.make(call("github.auth", undefined)).pipe(Atom.setIdleTTL("12 hours"))

/** A site's icon as a data URL, or null. Keyed by origin and kept, so scrolling back to a link never asks again. */
export const faviconAtom = Atom.family((origin: string) =>
  Atom.make(call("links.favicon", { url: origin })).pipe(Atom.keepAlive),
)

/** The GitHub repository a project's origin points at, or null. Asked once per project per session. */
export const repositoryAtom = Atom.family((projectId: string) =>
  Atom.make(call("github.repository", { projectId })).pipe(Atom.keepAlive),
)

export const secretStoredAtom = Atom.family((name: string) => Atom.make(call("secrets.has", { name })))

/** Re-lists the thread's open ports every 2s while something subscribes. */
export const threadPortsAtom = Atom.family((threadId: string) =>
  Atom.make(Stream.fromEffectSchedule(call("ports.list", { threadId }), Schedule.spaced("2 seconds"))),
)

const turnEnds = new Set(["turn_completed", "turn_failed", "turn_limited"])

/**
 * Tokens the thread spent, read from its agent's transcripts. Asked again when a turn ends or a sub-agent
 * changes, since workflow agents keep spending after the turn's result.
 */
export const threadUsageAtom = Atom.family((threadId: string) =>
  Atom.make((get) => {
    get.addFinalizer(
      onPushEvent((event) => {
        const turnEnded = event.type === "thread.event" && event.threadId === threadId && turnEnds.has(event.event.type)
        const subagentChanged = event.type === "thread.subagents" && event.threadId === threadId
        if (turnEnded || subagentChanged) get.refreshSelf()
      }),
    )
    return call("threads.usage", { threadId })
  }),
)

/** Plan limits of every signed-in account. Re-read every 2 minutes while subscribed and whenever a turn ends. */
export const accountLimitsAtom = Atom.make((get) => {
  get.addFinalizer(
    onPushEvent((event) => {
      if (event.type === "thread.event" && turnEnds.has(event.event.type)) get.refreshSelf()
    }),
  )
  return Stream.fromEffectSchedule(call("limits.list", undefined), Schedule.spaced("2 minutes"))
})

/** Polls the remote listener every 2s while subscribed so the device count stays current. */
export const remoteStatusAtom = Atom.make(
  Stream.fromEffectSchedule(call("remote.status", undefined), Schedule.spaced("2 seconds")),
)

/** Not kept alive, so reopening the page asks again and picks up a changed network. */
export const remotePairingAtom = Atom.make(call("remote.pairing", undefined))

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
