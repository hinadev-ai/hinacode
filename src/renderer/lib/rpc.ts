import { Effect, Schedule, Schema, Stream } from "effect"
import { AsyncResult, Atom } from "effect/reactivity"
import type { ProviderId } from "../../shared/agent.ts"
import { PushEvent, type RpcMethod, RpcMethods, type RpcRequest, type RpcResponse } from "../../shared/contract.ts"
import type { Thread } from "../../shared/domain.ts"
import { pullRequestAttention } from "../../shared/threadStatus.ts"
import { m } from "../paraglide/messages.js"

export class RpcError extends Schema.TaggedError<RpcError>()("RpcError", {
  tag: Schema.String,
  message: Schema.String,
}) {}

export type EnvironmentId = string | null

export interface CallOptions {
  readonly environment?: EnvironmentId | undefined
}

export const call = <M extends RpcMethod>(
  method: M,
  payload: RpcRequest<M>,
  options?: CallOptions,
): Effect.Effect<RpcResponse<M>, RpcError> => {
  const spec = RpcMethods[method]
  const encodeRequest = Schema.encodeEffect(spec.request)
  const decodeResponse = Schema.decodeUnknownEffect(spec.response)
  const environment = options?.environment ?? undefined
  return Effect.gen(function* () {
    const encoded = yield* encodeRequest(payload)
    const envelope = yield* Effect.promise(() => window.hinacode.rpc(method, encoded, environment))
    if ("error" in envelope) return yield* new RpcError(envelope.error)
    return yield* decodeResponse(envelope.result)
  }).pipe(
    Effect.catchTag("SchemaError", (error) => Effect.fail(new RpcError({ tag: error._tag, message: error.message }))),
  )
}

export const callPromise = <M extends RpcMethod>(method: M, payload: RpcRequest<M>, options?: CallOptions) =>
  Effect.runPromise(call(method, payload, options))

const decodePushEvent = Schema.decodeUnknownSync(PushEvent)

export const onPushEvent = (listener: (event: PushEvent) => void) =>
  window.hinacode.onEvent((raw) => listener(decodePushEvent(raw)))

export const familyOf = <Args extends ReadonlyArray<unknown>, A extends object>(make: (...args: Args) => A) => {
  const family = Atom.family((key: string) => make(...(JSON.parse(key) as Args)))
  return (...args: Args) => family(JSON.stringify(args))
}

export const projectsAtom = Atom.make(
  call("projects.list", undefined).pipe(
    Effect.map((projects) =>
      projects.map((project) => (project.kind === "chats" ? { ...project, name: m.sidebar_chats() } : project)),
    ),
  ),
).pipe(Atom.keepAlive)

type InEnvironment<T> = T & { readonly environment: EnvironmentId }

export const createProjectAtom = Atom.fn(({ environment, ...input }: InEnvironment<RpcRequest<"projects.create">>) =>
  call("projects.create", input, { environment }).pipe(Effect.tap(() => Atom.refresh(projectsAtom))),
)

export const cloneProjectAtom = Atom.fn(({ environment, ...input }: InEnvironment<RpcRequest<"projects.clone">>) =>
  call("projects.clone", input, { environment }).pipe(Effect.tap(() => Atom.refresh(projectsAtom))),
)

export const updateProjectAtom = Atom.fn((input: RpcRequest<"projects.update">) =>
  call("projects.update", input).pipe(Effect.tap(() => Atom.refresh(projectsAtom))),
)

export const settingsAtom = Atom.family((environment: EnvironmentId) =>
  Atom.make(call("settings.get", undefined, { environment })).pipe(Atom.keepAlive),
)

export const updateSettingsAtom = Atom.family((environment: EnvironmentId) =>
  Atom.fn((patch: RpcRequest<"settings.set">) =>
    call("settings.set", patch, { environment }).pipe(Effect.tap(() => Atom.refresh(settingsAtom(environment)))),
  ),
)

export const notificationPermissionAtom = Atom.make(call("notifications.permission", undefined))

export const clientSettingsAtom = Atom.make(call("clientSettings.get", undefined)).pipe(Atom.keepAlive)

export const updateClientSettingsAtom = Atom.fn((patch: RpcRequest<"clientSettings.set">) =>
  call("clientSettings.set", patch).pipe(Effect.tap(() => Atom.refresh(clientSettingsAtom))),
)

export const openersAtom = Atom.make(call("shell.openers", undefined))

export const worktreeCheckoutsAtom = Atom.make(
  call("worktrees.checkouts", undefined).pipe(
    Effect.map((checkouts) => new Map(checkouts.map((checkout) => [checkout.id, checkout.state]))),
  ),
)

export const worktreeCheckoutStateAtom = Atom.family((id: string) => Atom.make(call("worktrees.checkoutState", { id })))

export const environmentsAtom = Atom.make((get) => {
  get.addFinalizer(
    onPushEvent(
      (event) => (event.type === "environment.status" || event.type === "environments.changed") && get.refreshSelf(),
    ),
  )
  return call("environments.list", undefined)
}).pipe(Atom.keepAlive)

export const addEnvironmentAtom = Atom.fn((input: RpcRequest<"environments.add">) =>
  call("environments.add", input).pipe(Effect.tap(() => Atom.refresh(environmentsAtom))),
)

export const removeEnvironmentAtom = Atom.fn((id: string) =>
  call("environments.remove", { id }).pipe(
    Effect.tap(() => Atom.refresh(environmentsAtom)),
    Effect.tap(() => Atom.refresh(projectsAtom)),
  ),
)

export const reconnectEnvironmentAtom = Atom.fn((id: string) => call("environments.reconnect", { id }))

export const relayAccountAtom = Atom.make(call("relayAccount.status", undefined))

const relayAccountAction = <A>(effect: Effect.Effect<A, RpcError>) =>
  effect.pipe(
    Effect.tap(() => Atom.refresh(relayAccountAtom)),
    Effect.tap(() => Atom.refresh(environmentsAtom)),
  )

export const signInRelayAtom = Atom.fn((ownerToken: string) =>
  relayAccountAction(call("relayAccount.signIn", { ownerToken })),
)

export const signOutRelayAtom = Atom.fn(() => relayAccountAction(call("relayAccount.signOut", undefined)))

export const syncRelayAtom = Atom.fn(() => relayAccountAction(call("relayAccount.sync", undefined)))

export const relayMachinesAtom = Atom.make(call("relayAccount.machines", undefined))

const relayMachinesAction = <A>(effect: Effect.Effect<A, RpcError>) =>
  relayAccountAction(effect).pipe(Effect.tap(() => Atom.refresh(relayMachinesAtom)))

export const setRelayMachineShownAtom = Atom.fn((input: RpcRequest<"relayAccount.setShown">) =>
  relayMachinesAction(call("relayAccount.setShown", input)),
)

export const removeRelayMachineAtom = Atom.fn((id: string) =>
  relayMachinesAction(call("relayAccount.removeMachine", { id })),
)

export const pendingRelayLinkAtom = Atom.fn((userCode: string) => call("relayAccount.pendingLink", { userCode }))

export const approveRelayLinkAtom = Atom.fn((userCode: string) =>
  relayMachinesAction(call("relayAccount.approveLink", { userCode })),
)

export const modelsAtom = familyOf((environment: EnvironmentId, provider: ProviderId) =>
  Atom.make(call("models.list", { provider }, { environment })).pipe(Atom.keepAlive),
)

export const accountAtom = familyOf((environment: EnvironmentId, provider: ProviderId, accountId: string | null) =>
  Atom.make(call("agents.account", { provider, accountId }, { environment })),
)

export const refreshAccountAtom = Atom.fn(
  ({
    environment,
    provider,
    accountId,
  }: {
    environment: EnvironmentId
    provider: ProviderId
    accountId: string | null
  }) =>
    call("agents.account", { provider, accountId, refresh: true }, { environment }).pipe(
      Effect.tap(() => Atom.refresh(accountAtom(environment, provider, accountId))),
    ),
)

export const accountsAtom = Atom.family((environment: EnvironmentId) =>
  Atom.make(call("accounts.list", undefined, { environment })).pipe(Atom.keepAlive),
)

export const createAccountAtom = Atom.family((environment: EnvironmentId) =>
  Atom.fn((input: RpcRequest<"accounts.create">) =>
    call("accounts.create", input, { environment }).pipe(Effect.tap(() => Atom.refresh(accountsAtom(environment)))),
  ),
)

export const renameAccountAtom = Atom.family((environment: EnvironmentId) =>
  Atom.fn((input: RpcRequest<"accounts.rename">) =>
    call("accounts.rename", input, { environment }).pipe(Effect.tap(() => Atom.refresh(accountsAtom(environment)))),
  ),
)

export const deleteAccountAtom = Atom.family((environment: EnvironmentId) =>
  Atom.fn((id: string) =>
    call("accounts.delete", { id }, { environment }).pipe(
      Effect.tap(() => Atom.refresh(accountsAtom(environment))),
      Effect.tap(() => Atom.refresh(settingsAtom(environment))),
    ),
  ),
)

export const completionKey = (thread: Pick<Thread, "id" | "provider" | "accountId" | "worktreeId">) =>
  [thread.id, thread.provider, thread.accountId ?? "", thread.worktreeId ?? ""].join("\n")
const threadIdOf = (key: string) => key.split("\n")[0] ?? ""

export const commandsAtom = Atom.family((key: string) =>
  Atom.make(call("commands.list", { threadId: threadIdOf(key) })),
)

export const filesAtom = Atom.family((key: string) => Atom.make(call("files.list", { threadId: threadIdOf(key) })))

export const noFilesAtom = Atom.make(Effect.succeed<ReadonlyArray<string>>([]))

export const projectIconAtom = Atom.family((projectId: string) =>
  Atom.make(call("projects.icon", { id: projectId })).pipe(Atom.keepAlive),
)

export const currentBranchAtom = Atom.family((projectId: string) =>
  Atom.make(call("projects.currentBranch", { id: projectId })).pipe(Atom.makeRefreshOnSignal(windowReturnSignal)),
)

const remoteFetchAtom = Atom.family((projectId: string) =>
  Atom.make(call("projects.fetch", { id: projectId })).pipe(Atom.makeRefreshOnSignal(windowReturnSignal)),
)

export const branchesAtom = Atom.family((projectId: string) =>
  Atom.make((get) => {
    get(remoteFetchAtom(projectId))
    return call("projects.branches", { id: projectId })
  }),
)

export const pullRequestsAtom = Atom.family((projectId: string) =>
  Atom.make(call("projects.pullRequests", { id: projectId })).pipe(Atom.makeRefreshOnSignal(windowReturnSignal)),
)

export const pullRequestSearchAtom = familyOf((projectId: string, query: string | null) =>
  Atom.make(query === null ? Effect.succeed([]) : call("projects.searchPullRequests", { id: projectId, query })).pipe(
    Atom.setIdleTTL("1 minute"),
  ),
)

export const defaultBranchAtom = Atom.family((projectId: string) =>
  Atom.make((get) => {
    get(remoteFetchAtom(projectId))
    return call("projects.defaultBranch", { id: projectId })
  }),
)

export const fileContentAtom = Atom.family((key: string) => {
  const [root, path] = JSON.parse(key) as [string, string]
  return Atom.make(call("fs.read", { root, path }))
})

export const threadChangesAtom = Atom.family((key: string) => {
  const [threadId = "", scope] = key.split("\n")
  return Atom.make(call("threads.changes", { threadId, scope: scope === "turn" ? "turn" : "worktree" })).pipe(
    Atom.makeRefreshOnSignal(windowReturnSignal),
  )
})

export const gitLogLimitAtom = Atom.family((_root: string) => Atom.make(200))

export const gitLogAtom = Atom.family((root: string) =>
  Atom.make((get) => {
    get.addFinalizer(
      onPushEvent((event) => event.type === "worktree.updated" && event.worktree.path === root && get.refreshSelf()),
    )
    return call("git.log", { root, limit: get(gitLogLimitAtom(root)) })
  }),
)

export const commitDiffAtom = Atom.family((key: string) => {
  const [root = "", hash = ""] = key.split("\n")
  return Atom.make(call("git.show", { root, hash }))
})
export const commitKey = (root: string, hash: string) => `${root}\n${hash}`

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

const gitHubLookup = <Args extends ReadonlyArray<unknown>, A>(
  lookup: (...args: Args) => Effect.Effect<A, RpcError>,
) => {
  // FIXME: an atom family holds its atoms weakly, and the wrapper below is dropped on unmount
  const cached = familyOf((...args: Args) => Atom.make(lookup(...args)).pipe(Atom.setIdleTTL("10 minutes")))
  return familyOf((...args: Args) =>
    cached(...args).pipe(
      Atom.swr({ staleTime: "30 seconds", revalidateOnFocus: true, focusSignal: windowReturnSignal }),
      Atom.withRefresh("60 seconds"),
    ),
  )
}

export const branchPullRequestAtom = gitHubLookup((worktreeId: string | null) =>
  worktreeId ? call("worktrees.pullRequest", { id: worktreeId }) : Effect.succeed(null),
)

export const pullRequestStatusAtom = gitHubLookup((environment: EnvironmentId, url: string) =>
  call("github.pullRequest", { url }, { environment }),
)

export const pullRequestStatusesAtom = familyOf((environment: EnvironmentId, urls: ReadonlyArray<string>) =>
  Atom.make((get) =>
    urls.map((url) => {
      const lookup = get(pullRequestStatusAtom(environment, url))
      return AsyncResult.isSuccess(lookup) ? lookup.value : undefined
    }),
  ),
)

export const pullRequestAttentionAtom = familyOf((environment: EnvironmentId, urls: ReadonlyArray<string>) =>
  Atom.make((get) => pullRequestAttention(get(pullRequestStatusesAtom(environment, urls)))),
)

export const pullRequestAttentionsAtom = familyOf(
  (threads: ReadonlyArray<readonly [EnvironmentId, ReadonlyArray<string>]>) =>
    Atom.make((get) => threads.map(([environment, urls]) => get(pullRequestAttentionAtom(environment, urls)))),
)

export const pullRequestDetailAtom = gitHubLookup((environment: EnvironmentId, url: string) =>
  call("github.pullRequestDetail", { url }, { environment }),
)

export const pullRequestFilesAtom = familyOf((environment: EnvironmentId, url: string, _forHead: string) =>
  Atom.make(call("github.pullRequestFiles", { url }, { environment })).pipe(Atom.setIdleTTL("10 minutes")),
)

export const gitHubAuthAtom = Atom.family((environment: EnvironmentId) =>
  Atom.make(call("github.auth", undefined, { environment })).pipe(Atom.setIdleTTL("12 hours")),
)

export const faviconAtom = Atom.family((origin: string) =>
  Atom.make(call("links.favicon", { url: origin })).pipe(Atom.keepAlive),
)

export const repositoryAtom = Atom.family((projectId: string) =>
  Atom.make(call("github.repository", { projectId })).pipe(Atom.keepAlive),
)

export const secretStoredAtom = familyOf((environment: EnvironmentId, name: string) =>
  Atom.make(call("secrets.has", { name }, { environment })),
)

export const threadPortsAtom = Atom.family((threadId: string) =>
  Atom.make(
    Stream.fromEffectSchedule(
      call("ports.list", { threadId }).pipe(
        Effect.retry({ while: (error) => error.tag === "EnvironmentOffline", schedule: Schedule.spaced("2 seconds") }),
      ),
      Schedule.spaced("2 seconds"),
    ),
  ),
)

const pushFirst =
  <A>(extract: (event: PushEvent) => A | undefined, fetch: Effect.Effect<A, RpcError>) =>
  (get: {
    addFinalizer: (finalizer: () => void) => void
    setSelf: (result: AsyncResult.AsyncResult<A, RpcError>) => void
  }) => {
    let pushed: A | undefined
    get.addFinalizer(
      onPushEvent((event) => {
        const value = extract(event)
        if (value === undefined) return
        pushed = value
        get.setSelf(AsyncResult.success(value))
      }),
    )
    return Effect.map(fetch, (fetched) => pushed ?? fetched)
  }

export const threadVmAtom = Atom.family((threadId: string) =>
  Atom.make(
    pushFirst(
      (event) => (event.type === "vm.updated" && event.threadId === threadId ? event.vm : undefined),
      call("vm.get", { threadId }),
    ),
  ),
)

export const threadDevicesAtom = Atom.family((threadId: string) =>
  Atom.make(
    pushFirst(
      (event) => (event.type === "device.updated" && event.threadId === threadId ? event.devices : undefined),
      call("device.get", { threadId }),
    ),
  ),
)

export const vmDesktopUrlAtom = familyOf((threadId: string, _sandboxId: string) =>
  Atom.make(call("vm.desktop.url", { threadId })),
)

export const deviceHostAtom = Atom.family((threadId: string) => Atom.make(call("devices.list", { threadId })))

export const vmHostAtom = Atom.family((environment: EnvironmentId) =>
  Atom.make(call("vm.host", undefined, { environment })),
)

export const threadVmPasskeyAtom = Atom.family((threadId: string) =>
  Atom.make(
    pushFirst(
      (event) => (event.type === "vm.passkey.updated" && event.threadId === threadId ? event.passkey : undefined),
      call("vm.passkey.get", { threadId }),
    ),
  ),
)

const turnEnds = new Set(["turn_completed", "turn_failed", "turn_limited"])

export const contextBreakdownAtom = Atom.family((threadId: string) =>
  Atom.make((get) => {
    get.addFinalizer(
      onPushEvent((event) => {
        if (event.type === "thread.event" && event.threadId === threadId && turnEnds.has(event.event.type)) {
          get.refreshSelf()
        }
      }),
    )
    return call("threads.contextBreakdown", { threadId })
  }),
)

export const accountLimitsAtom = Atom.make((get) => {
  get.addFinalizer(
    onPushEvent((event) => {
      if (event.type === "thread.event" && turnEnds.has(event.event.type)) get.refreshSelf()
    }),
  )
  return Stream.fromEffectSchedule(call("limits.list", undefined), Schedule.spaced("2 minutes"))
})

export const remoteStatusAtom = Atom.make(
  Stream.fromEffectSchedule(call("remote.status", undefined), Schedule.spaced("2 seconds")),
)

export const machineResourcesAtom = Atom.family((environment: EnvironmentId) =>
  Atom.make(
    Stream.fromEffectSchedule(call("system.resources", undefined, { environment }), Schedule.spaced("5 seconds")),
  ),
)

export const remotePairingAtom = Atom.make((get) => {
  get(settingsAtom(null))
  return call("remote.pairing", undefined)
})

export const networkAddressesAtom = Atom.family((environment: EnvironmentId) =>
  Atom.make(call("network.addresses", undefined, { environment })),
)

export const updateStatusAtom = Atom.family((environment: EnvironmentId) =>
  Atom.make((get) => {
    get.addFinalizer(
      onPushEvent(
        (event) => (event.type === "update.changed" || event.type === "environment.status") && get.refreshSelf(),
      ),
    )
    return call("updates.status", undefined, { environment })
  }),
)

export const cloudUpdatesAtom = Atom.make((get) =>
  Effect.gen(function* () {
    const { clouds } = yield* get.result(environmentsAtom)
    const ready = yield* Effect.forEach(
      clouds.filter((cloud) => cloud.status === "connected"),
      (cloud) =>
        get.result(updateStatusAtom(cloud.id)).pipe(
          Effect.map((status) => (status.state.type === "ready" ? [cloud.id] : [])),
          Effect.orElseSucceed(() => []),
        ),
      { concurrency: "unbounded" },
    )
    return ready.flat()
  }),
)

export const installUpdatesAtom = Atom.fn((environments: ReadonlyArray<EnvironmentId>) =>
  Effect.forEach(environments, (environment) => call("updates.install", undefined, { environment }), {
    concurrency: "unbounded",
    discard: true,
  }),
)

const onAutomationRun = (listener: (automationId: string) => void) =>
  onPushEvent((event) => event.type === "automation.run" && listener(event.run.automationId))

export const automationsAtom = Atom.family((environment: EnvironmentId) =>
  Atom.make((get) => {
    get.addFinalizer(onAutomationRun(() => get.refreshSelf()))
    return Stream.fromEffectSchedule(
      call("automations.list", undefined, { environment }),
      Schedule.spaced("15 seconds"),
    )
  }),
)

export const automationRunsAtom = Atom.family((automationId: string) =>
  Atom.make((get) => {
    get.addFinalizer(onAutomationRun((id) => id === automationId && get.refreshSelf()))
    return call("automations.runs", { id: automationId, limit: 20 })
  }),
)

export const webhookUrlAtom = familyOf((environment: EnvironmentId, automationId: string) =>
  Atom.make((get) => {
    get(settingsAtom(environment))
    return call("automations.webhookUrl", { id: automationId })
  }),
)
