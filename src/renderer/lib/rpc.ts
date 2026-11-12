import { Duration, Effect, Option, Schedule, Schema } from "effect"
import { AsyncResult, Atom } from "effect/reactivity"
import { ProviderId } from "../../shared/agent.ts"
import {
  PushEvent,
  type RpcMethod,
  RpcMethods,
  type RpcRequest,
  type RpcResponse,
  transcriptThreadId,
} from "../../shared/contract.ts"
import { looksLikeDirectoryPath } from "../../shared/directoryPath.ts"
import type { Thread } from "../../shared/domain.ts"
import { PULL_REQUEST_REFRESH } from "../../shared/github.ts"
import { msUntilNextReset } from "../../shared/planLimits.ts"
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
const decodeTranscriptAddress = Schema.decodeUnknownOption(
  Schema.Union([
    Schema.Struct({ type: Schema.Literal("thread.event"), threadId: Schema.String }),
    Schema.Struct({
      type: Schema.Literals(["message.created", "message.updated"]),
      message: Schema.Struct({ threadId: Schema.String }),
    }),
  ]),
)

export type RendererPushEvent = PushEvent | { readonly type: "transcript.lost"; readonly threadId: string }

let pushListeners: ReadonlyArray<(event: RendererPushEvent) => void> = []
let stopBridgeEvents: (() => void) | undefined

const decodeOrReportLoss = (raw: unknown): RendererPushEvent | undefined => {
  try {
    return decodePushEvent(raw)
  } catch (error) {
    reportError(error)
    const address = decodeTranscriptAddress(raw)
    return Option.isSome(address) ? { type: "transcript.lost", threadId: transcriptThreadId(address.value) } : undefined
  }
}

const broadcastPushEvent = (raw: typeof PushEvent.Encoded) => {
  const event = decodeOrReportLoss(raw)
  if (event === undefined) return
  for (const listener of pushListeners) {
    try {
      listener(event)
    } catch (error) {
      reportError(error)
    }
  }
}

export const onPushEvent = (listener: (event: RendererPushEvent) => void) => {
  pushListeners = [...pushListeners, listener]
  stopBridgeEvents ??= window.hinacode.onEvent(broadcastPushEvent)
  return () => {
    pushListeners = pushListeners.filter((other) => other !== listener)
    if (pushListeners.length > 0) return
    stopBridgeEvents?.()
    stopBridgeEvents = undefined
  }
}

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

export const worktreeCheckoutStateAtom = Atom.family((id: string) =>
  Atom.make(call("worktrees.checkoutState", { id })).pipe(Atom.makeRefreshOnSignal(windowReturnSignal)),
)

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
    Effect.ensuring(Atom.refresh(relayAccountAtom)),
    Effect.ensuring(Atom.refresh(environmentsAtom)),
    Effect.ensuring(Atom.refresh(remotePairingAtom)),
  )

export const signInRelayAtom = Atom.fn(() => relayAccountAction(call("relayAccount.signIn", undefined)))

export const signOutRelayAtom = Atom.fn(() => relayAccountAction(call("relayAccount.signOut", undefined)))

export const syncRelayAtom = Atom.fn(() => relayAccountAction(call("relayAccount.sync", undefined)))

export const appConnectionsAtom = Atom.make((get) => {
  get.addFinalizer(onPushEvent((event) => event.type === "appConnections.changed" && get.refreshSelf()))
  return call("appConnections.status", undefined)
})

export const relayMachinesAtom = Atom.make(call("relayAccount.machines", undefined))

const relayMachinesAction = <A>(effect: Effect.Effect<A, RpcError>) =>
  relayAccountAction(effect).pipe(Effect.tap(() => Atom.refresh(relayMachinesAtom)))

export const setRelayMachineShownAtom = Atom.fn((input: RpcRequest<"relayAccount.setShown">) =>
  relayMachinesAction(call("relayAccount.setShown", input)),
)

export const removeRelayMachineAtom = Atom.fn((id: string) =>
  relayMachinesAction(call("relayAccount.removeMachine", { id })),
)

export const modelsAtom = familyOf((environment: EnvironmentId, provider: ProviderId) =>
  Atom.make(call("models.list", { provider }, { environment })).pipe(Atom.keepAlive),
)

export const binariesAtom = familyOf((environment: EnvironmentId) =>
  Atom.make(call("agents.binaries", undefined, { environment })),
)

export const accountAtom = familyOf((environment: EnvironmentId, provider: ProviderId, accountId: string | null) =>
  Atom.make(call("agents.account", { provider, accountId }, { environment })),
)

const isSetUp = (account: AsyncResult.AsyncResult<RpcResponse<"agents.account">, RpcError>) =>
  AsyncResult.isInitial(account) || (AsyncResult.isSuccess(account) && account.value.type !== "signedOut")

export const setUpProvidersAtom = Atom.family((environment: EnvironmentId) =>
  Atom.make((get) => ProviderId.literals.filter((provider) => isSetUp(get(accountAtom(environment, provider, null))))),
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

export const externalSessionsAtom = Atom.family((projectId: string) =>
  Atom.make(call("sessions.listExternal", { projectId })),
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

const remoteFetchedAtAtom = Atom.family((projectId: string) =>
  Atom.make((get) => AsyncResult.getOrElse(get(remoteFetchAtom(projectId)), () => null)),
)

export const branchesAtom = Atom.family((projectId: string) =>
  Atom.make((get) => {
    get(remoteFetchedAtAtom(projectId))
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

export const directorySuggestionsAtom = familyOf((environment: EnvironmentId, path: string) =>
  Atom.make(
    looksLikeDirectoryPath(path) ? call("fs.completeDirectory", { path }, { environment }) : Effect.succeed([]),
  ).pipe(Atom.setIdleTTL("10 seconds")),
)

export const defaultBranchAtom = Atom.family((projectId: string) =>
  Atom.make((get) => {
    get(remoteFetchedAtAtom(projectId))
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

export const turnChangesAtom = Atom.family((messageKey: string) => {
  const [threadId = ""] = messageKey.split("\n")
  return Atom.make(call("threads.changes", { threadId, scope: "turn" }))
})
export const turnChangesKey = (threadId: string, messageId: string) => `${threadId}\n${messageId}`

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
  let away = false
  const leave = () => {
    away = true
  }
  const comeBack = () => {
    if (!away || document.visibilityState !== "visible") return
    away = false
    get.setSelf(++count)
  }
  const onVisibilityChange = () => (document.visibilityState === "visible" ? comeBack() : leave())
  window.addEventListener("blur", leave)
  window.addEventListener("focus", comeBack)
  document.addEventListener("visibilitychange", onVisibilityChange)
  get.addFinalizer(() => {
    window.removeEventListener("blur", leave)
    window.removeEventListener("focus", comeBack)
    document.removeEventListener("visibilitychange", onVisibilityChange)
  })
  return count
})

const refreshInStepWhileVisible =
  (interval: Duration.Duration) =>
  <A, E>(self: Atom.Atom<AsyncResult.AsyncResult<A, E>>) => {
    const millis = Duration.toMillis(interval)
    return Atom.transform(self, (get) => {
      let timer: ReturnType<typeof setTimeout>
      const result = get(self)
      const scheduleNextRefresh = () => {
        timer = setTimeout(
          () => {
            scheduleNextRefresh()
            if (!document.hidden && !AsyncResult.isWaiting(result)) get.refresh(self)
          },
          millis - (Date.now() % millis),
        )
      }
      scheduleNextRefresh()
      get.addFinalizer(() => clearTimeout(timer))
      return result
    })
  }

const gitHubLookup = <Args extends ReadonlyArray<unknown>, A>(
  lookup: (...args: Args) => (get: Atom.AtomContext) => Effect.Effect<A, RpcError>,
  { revalidateOnFocus = true }: { readonly revalidateOnFocus?: boolean } = {},
) => {
  // FIXME: an atom family holds its atoms weakly, and the wrapper below is dropped on unmount
  const cached = familyOf((...args: Args) => Atom.make(lookup(...args)).pipe(Atom.setIdleTTL("10 minutes")))
  return familyOf((...args: Args) =>
    cached(...args).pipe(
      Atom.swr({ staleTime: "30 seconds", revalidateOnFocus, focusSignal: windowReturnSignal }),
      refreshInStepWhileVisible(PULL_REQUEST_REFRESH),
    ),
  )
}

const refreshWhenPullRequestChanges = (get: Atom.AtomContext, url: string) =>
  get.addFinalizer(
    onPushEvent((event) => {
      if (event.type === "github.pullRequest" && event.url === url) get.refreshSelf()
    }),
  )

export const branchPullRequestAtom = gitHubLookup(
  (worktreeId: string | null) => (get) =>
    worktreeId
      ? call("worktrees.pullRequest", { id: worktreeId }).pipe(
          Effect.tap((pullRequest) =>
            Effect.sync(() => {
              if (pullRequest !== null) refreshWhenPullRequestChanges(get, pullRequest.url)
            }),
          ),
        )
      : Effect.succeed(null),
)

export const pullRequestStatusAtom = gitHubLookup((environment: EnvironmentId, url: string) => (get) => {
  refreshWhenPullRequestChanges(get, url)
  return call("github.pullRequest", { url }, { environment })
})

export const issueAtom = gitHubLookup(
  (environment: EnvironmentId, url: string) => () => call("github.issue", { url }, { environment }),
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

const pullRequestDetailLookup = gitHubLookup(
  (environment: EnvironmentId, url: string) => (get) => {
    refreshWhenPullRequestChanges(get, url)
    return call("github.pullRequestDetail", { url }, { environment })
  },
  { revalidateOnFocus: false },
)

const readFreshOnWindowReturn =
  (environment: EnvironmentId, url: string) =>
  <A>(self: Atom.Atom<A>) =>
    Atom.transform(self, (get) => {
      get.once(windowReturnSignal)
      get.subscribe(windowReturnSignal, () =>
        Effect.runFork(Effect.ignore(call("github.pullRequestDetail", { url, fresh: true }, { environment }))),
      )
      return get(self)
    })

export const pullRequestDetailAtom = familyOf((environment: EnvironmentId, url: string) =>
  pullRequestDetailLookup(environment, url).pipe(readFreshOnWindowReturn(environment, url)),
)

export const pullRequestFilesAtom = familyOf((environment: EnvironmentId, url: string, _forHead: string) =>
  Atom.make(call("github.pullRequestFiles", { url }, { environment })).pipe(Atom.setIdleTTL("10 minutes")),
)

export const pullRequestCandidatesAtom = familyOf((environment: EnvironmentId, url: string) =>
  Atom.make(call("github.pullRequestCandidates", { url }, { environment })).pipe(Atom.setIdleTTL("10 minutes")),
)

export const pullRequestFileContentAtom = familyOf(
  (environment: EnvironmentId, url: string, ref: string, path: string) =>
    Atom.make(call("github.fileContent", { url, ref, path }, { environment })).pipe(Atom.setIdleTTL("10 minutes")),
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
    call("ports.list", { threadId }).pipe(
      Effect.retry({ while: (error) => error.tag === "EnvironmentOffline", schedule: Schedule.spaced("2 seconds") }),
    ),
  ).pipe(refreshInStepWhileVisible(Duration.seconds(2))),
)

const pushFirst =
  <A>(extract: (event: RendererPushEvent) => A | undefined, fetch: Effect.Effect<A, RpcError>) =>
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

const longestTimeoutMs = 2 ** 31 - 1

export const accountLimitsAtom = Atom.make((get) => {
  get.addFinalizer(
    onPushEvent((event) => {
      if (event.type === "thread.event" && turnEnds.has(event.event.type)) get.refreshSelf()
    }),
  )
  return call("limits.list", undefined).pipe(
    Effect.tap((limits) =>
      Effect.sync(() => {
        const resetIn = msUntilNextReset(limits, Date.now())
        if (resetIn === undefined) return
        const timer = setTimeout(() => get.refreshSelf(), Math.min(resetIn, longestTimeoutMs))
        get.addFinalizer(() => clearTimeout(timer))
      }),
    ),
  )
}).pipe(Atom.swr({ staleTime: "5 minutes", revalidateOnFocus: true, focusSignal: windowReturnSignal }))

export const remoteStatusAtom = Atom.make(call("remote.status", undefined)).pipe(
  refreshInStepWhileVisible(Duration.seconds(2)),
)

export const machineResourcesAtom = Atom.family((environment: EnvironmentId) =>
  Atom.make(call("system.resources", undefined, { environment })).pipe(refreshInStepWhileVisible(Duration.seconds(5))),
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

const onRoutineRun = (listener: (routineId: string) => void) =>
  onPushEvent((event) => event.type === "routine.run" && listener(event.run.routineId))

export const routinesAtom = Atom.make((get) => {
  get.addFinalizer(
    onPushEvent(
      (event) =>
        (event.type === "routine.run" ||
          event.type === "routines.changed" ||
          event.type === "environment.status" ||
          event.type === "environments.changed") &&
        get.refreshSelf(),
    ),
  )
  return call("routines.list", undefined)
})

export const artifactsAtom = Atom.make((get) => {
  get.addFinalizer(
    onPushEvent(
      (event) =>
        (event.type === "artifact.updated" ||
          event.type === "artifact.removed" ||
          event.type === "environment.status" ||
          event.type === "environments.changed") &&
        get.refreshSelf(),
    ),
  )
  return call("artifacts.list", undefined).pipe(
    Effect.map((artifacts) => artifacts.toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt))),
  )
})

export const documentAtom = familyOf((environment: EnvironmentId, id: string) =>
  Atom.make(call("artifacts.readDocument", { id }, { environment })),
)

export const ROUTINE_RUN_HISTORY = 200

export const routineRunsAtom = Atom.family((routineId: string) =>
  Atom.make((get) => {
    get.addFinalizer(onRoutineRun((id) => id === routineId && get.refreshSelf()))
    return call("routines.runs", { id: routineId, limit: ROUTINE_RUN_HISTORY })
  }),
)

export const routineWebhookAtom = familyOf((environment: EnvironmentId, routineId: string) =>
  Atom.make((get) => {
    get(settingsAtom(environment))
    get.addFinalizer(onPushEvent((event) => event.type === "routines.changed" && get.refreshSelf()))
    return call("routines.webhook", { id: routineId })
  }),
)

export const projectCommandsAtom = familyOf((projectId: string, provider: ProviderId) =>
  Atom.make(call("commands.forProject", { projectId, provider })),
)
