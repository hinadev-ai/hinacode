import { randomUUID } from "node:crypto"
import {
  Cache,
  Context,
  Deferred,
  Duration,
  Effect,
  FiberMap,
  Layer,
  Predicate,
  type Schema,
  Schedule,
  Semaphore,
  Stream,
} from "effect"
import type { RpcResponse, TranscriptPush } from "../../shared/contract.ts"
import type {
  AccountHome,
  AccountLimits,
  AgentCommand,
  AgentEvent,
  ApprovalDecision,
  ApprovalRequest,
  ModelInfo,
  ProviderId,
  QuestionAnswers,
  QuestionRequest,
  Subagent,
  BackgroundTask,
  SecretRequest,
  ThreadUsage,
} from "../../shared/agent.ts"
import type {
  AccessMode,
  Attachment,
  Message,
  QueuedMessage,
  Thread,
  ThreadStatus,
  WorkspaceChoice,
} from "../../shared/domain.ts"
import { isThreadBusy } from "../../shared/domain.ts"
import { foldTranscript } from "../../shared/foldEvent.ts"
import { ClaudeProvider } from "../agents/claude/index.ts"
import { CodexProvider } from "../agents/codex/index.ts"
import { agentInstructions } from "../agents/instructions.ts"
import { MuseProvider } from "../agents/muse/index.ts"
import { McpCredentials } from "../mcp/credentials.ts"
import { AgentError, type AgentProvider, type Wake } from "../agents/provider.ts"
import { Events } from "./Events.ts"
import { nowIso } from "./clock.ts"
import {
  NotFoundError,
  type PersistenceError,
  type PullRequestElsewhereError,
  type RootBusyError,
  ThreadStartedError,
  type WorktreeTakenError,
} from "./errors.ts"
import type { CommandError } from "./Git.ts"
import type { GitHubError, PullRequestUrlInvalidError } from "./GitHub.ts"
import { Messages } from "./Messages.ts"
import { PullRequests } from "./PullRequests.ts"
import { Secrets } from "./Secrets.ts"
import { Settings } from "./Settings.ts"
import { ThreadNaming } from "./ThreadNaming.ts"
import { Threads } from "./Threads.ts"
import { Worktrees } from "./Worktrees.ts"
import { AgentAccounts } from "./AgentAccounts.ts"
import { makeActiveWorkspace } from "./workspace.ts"

const PERSIST_INTERVAL_MS = 500
/** Streaming persists wait this many times as long as the last one took, capping them near a tenth of the main thread. */
const PERSIST_BACKOFF = 10
const interruptedSend = () => new AgentError({ provider: "hinacode", message: "Message send interrupted" })

export interface SendOptions {
  /** Only with the first message: sets up where the thread runs first. */
  readonly workspace?: WorkspaceChoice | undefined
}

type SendError =
  | AgentError
  | PersistenceError
  | NotFoundError
  | CommandError
  | WorktreeTakenError
  | ThreadStartedError
  | GitHubError
  | Schema.SchemaError
  | PullRequestElsewhereError
  | PullRequestUrlInvalidError
  | RootBusyError

export class AgentRunner extends Context.Service<
  AgentRunner,
  {
    /**
     * Starts a turn in the background. Fails if the thread already has one in flight.
     * The first message of a thread a user created also names the thread and its branch in the background.
     */
    readonly send: (
      threadId: string,
      prompt: string,
      attachments: ReadonlyArray<Attachment>,
      options?: SendOptions,
    ) => Effect.Effect<void, SendError>
    /** Adds input to the thread's running turn, or starts a turn when none is running. */
    readonly steer: (
      threadId: string,
      text: string,
      attachments: ReadonlyArray<Attachment>,
    ) => Effect.Effect<void, SendError>
    /** Queues the message while the thread is busy; sends it like `send` when it is not. */
    readonly queue: (
      threadId: string,
      text: string,
      attachments: ReadonlyArray<Attachment>,
    ) => Effect.Effect<void, SendError>
    /** Takes one message out of the queue. Null when it already left, e.g. because its turn started. */
    readonly unqueue: (
      threadId: string,
      id: string,
    ) => Effect.Effect<QueuedMessage | null, PersistenceError | NotFoundError | ThreadStartedError>
    readonly steerWhen: (input: {
      readonly threadId: string
      readonly text: string
      readonly attachments: ReadonlyArray<Attachment>
      readonly when: Effect.Effect<boolean, PersistenceError>
    }) => Effect.Effect<boolean, SendError>
    readonly interrupt: (threadId: string) => Effect.Effect<void>
    readonly resumeAtReset: (
      threadId: string,
      enabled: boolean,
    ) => Effect.Effect<Thread, AgentError | PersistenceError | NotFoundError | ThreadStartedError>
    /**
     * Moves the thread to another account of its agent. A started session is copied into the new account's home
     * first, so the next turn keeps its history. A limited thread goes back to idle, because the limit was the
     * old account's. `resend` sends the last prompt again. Refused while a turn runs.
     */
    readonly switchAccount: (
      threadId: string,
      accountId: string | null,
      options: { readonly resend: boolean },
    ) => Effect.Effect<Thread, SendError>
    /** Reaches a running turn where the agent supports it; otherwise the next turn starts in the new mode. */
    readonly setAccessMode: (threadId: string, accessMode: AccessMode) => Effect.Effect<void, AgentError>
    readonly respondApproval: (requestId: string, decision: ApprovalDecision) => Effect.Effect<void>
    readonly respondQuestion: (requestId: string, answers: QuestionAnswers) => Effect.Effect<void>
    /**
     * Shows the user a secret card in the thread and waits for their answer. Fails when no turn is
     * running or the turn ends first. The value never passes through here: see `respondSecret`.
     */
    readonly requestSecret: (
      threadId: string,
      name: string,
      description: string,
    ) => Effect.Effect<"stored" | "declined", AgentError | PersistenceError | NotFoundError | ThreadStartedError>
    /** `value: null` declines; otherwise the value is stored under the request's name before the agent learns of it. */
    readonly respondSecret: (
      requestId: string,
      value: string | null,
    ) => Effect.Effect<void, PersistenceError | NotFoundError | ThreadStartedError>
    readonly transcript: (threadId: string) => Effect.Effect<RpcResponse<"threads.transcript">, PersistenceError>
    readonly listModels: (provider: ProviderId) => Effect.Effect<ReadonlyArray<ModelInfo>, AgentError>
    /**
     * One entry for each provider's CLI login and each added account. One that fails to answer or is signed out
     * reports null limits.
     */
    readonly limits: Effect.Effect<ReadonlyArray<AccountLimits>, PersistenceError>
    /** Null until the thread's first turn binds an agent session. */
    readonly usage: (
      threadId: string,
    ) => Effect.Effect<ThreadUsage | null, AgentError | PersistenceError | NotFoundError>
    /** Sub-agents the thread's agent spawned since the app started, newest first. */
    readonly subagents: (threadId: string) => Effect.Effect<ReadonlyArray<Subagent>>
    /** Stops one running sub-agent; the turn that spawned it keeps going. */
    readonly stopSubagent: (
      threadId: string,
      subagentId: string,
    ) => Effect.Effect<void, AgentError | PersistenceError | NotFoundError>
    /** Background tasks the thread's agent has running now, oldest first. */
    readonly backgroundTasks: (threadId: string) => Effect.Effect<ReadonlyArray<BackgroundTask>>
    readonly stopBackgroundTask: (
      threadId: string,
      taskId: string,
    ) => Effect.Effect<void, AgentError | PersistenceError | NotFoundError>
    readonly listCommands: (
      threadId: string,
    ) => Effect.Effect<ReadonlyArray<AgentCommand>, AgentError | PersistenceError | NotFoundError>
  }
>()("hinacode/AgentRunner") {}

/** Thread status a turn moves to on this event, if any. */
const statusAfter = (event: AgentEvent): ThreadStatus | undefined => {
  switch (event.type) {
    case "approval_requested":
    case "question_requested":
    case "secret_requested":
      return "awaiting_approval"
    case "approval_resolved":
    case "question_resolved":
    case "secret_resolved":
      return "running"
    case "turn_completed":
    case "turn_failed":
      return "idle"
    case "turn_limited":
      return "limited"
    default:
      return undefined
  }
}

const userMessage = (threadId: string, text: string, attachments: ReadonlyArray<Attachment>, now: string): Message => ({
  id: randomUUID(),
  threadId,
  role: "user",
  parts: [
    ...(text === "" ? [] : [{ type: "text" as const, text }]),
    ...attachments.map((attachment) => ({ type: "attachment" as const, attachment })),
  ],
  createdAt: now,
  completedAt: now,
  usage: null,
})

const openAssistantMessage = (threadId: string, now: string): Message => ({
  id: randomUUID(),
  threadId,
  role: "assistant",
  parts: [],
  createdAt: now,
  completedAt: null,
  usage: null,
})

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

/**
 * Screenshots are megabytes of base64 nobody reads in the transcript, so only their type is kept. Claude
 * sends `{ type: "image", source: { media_type, data } }`, MCP `{ type: "image", mimeType, data }`.
 */
const withoutImageData = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(withoutImageData)
  if (!Predicate.isObject(value)) return value
  const record = value as Record<string, unknown>
  if (record["type"] === "image") {
    const source = record["source"]
    const mimeType =
      record["mimeType"] ?? (Predicate.isObject(source) ? (source as Record<string, unknown>)["media_type"] : undefined)
    return { type: "image", mimeType }
  }
  return Object.fromEntries(Object.entries(record).map(([key, nested]) => [key, withoutImageData(nested)]))
}

const replaceLast = (messages: ReadonlyArray<Message>, message: Message) => [...messages.slice(0, -1), message]

const make = Effect.gen(function* () {
  const scope = yield* Effect.scope
  const threads = yield* Threads
  const worktrees = yield* Worktrees
  const pullRequests = yield* PullRequests
  const messages = yield* Messages
  const push = yield* Events
  const mcp = yield* McpCredentials
  const secrets = yield* Secrets
  const settings = yield* Settings
  const naming = yield* ThreadNaming
  const accounts = yield* AgentAccounts
  const activeWorkspace = yield* makeActiveWorkspace

  const providers: Record<ProviderId, AgentProvider> = {
    claude: yield* ClaudeProvider,
    codex: yield* CodexProvider,
    muse: yield* MuseProvider,
  }

  type LimitsKey = Pick<AccountLimits, "provider" | "accountId">
  // A Claude read spawns a CLI, so each account is asked at most once a minute. Keyed by a `LimitsKey` as JSON.
  const cachedLimits = yield* Cache.make({
    lookup: (key: string) => {
      const { provider, accountId } = JSON.parse(key) as LimitsKey
      return accounts.home(accountId).pipe(
        Effect.flatMap(providers[provider].planLimits),
        Effect.orElseSucceed(() => null),
        Effect.map((limits): AccountLimits => ({ provider, accountId, limits })),
      )
    },
    capacity: 64,
    timeToLive: Duration.minutes(1),
  })

  const turns = yield* FiberMap.make<string>()
  const busyThreads = new Set<string>()
  const pendingSends = new Map<string, Deferred.Deferred<void>>()
  const activeTurns = new Map<string, ReturnType<typeof makeTurn>>()
  const approvals = new Map<string, ApprovalRequest>()
  const questions = new Map<string, QuestionRequest>()
  const secretRequests = new Map<
    string,
    { readonly request: SecretRequest; readonly answer: Deferred.Deferred<"stored" | "declined", AgentError> }
  >()
  const threadLocks = new Map<string, Semaphore.Semaphore>()
  /** Latest state of each sub-agent per thread, in spawn order. Kept in memory only, so it ends with the app. */
  const subagents = new Map<string, Map<string, Subagent>>()
  /** Background tasks per thread, as the provider last reported them. A thread with none is absent. */
  const backgroundTasks = new Map<string, ReadonlyArray<BackgroundTask>>()
  let seq = 0

  // Nothing runs at boot, so whatever a killed app left running is over.
  yield* threads.resetInterrupted
  yield* messages.closeInterrupted

  const providerFor = (id: ProviderId) => Effect.succeed(providers[id])

  const respondApproval = (requestId: string, decision: ApprovalDecision) =>
    Effect.suspend(() => {
      const request = approvals.get(requestId)
      if (request === undefined) return Effect.void
      return providers[request.provider]?.respondApproval(requestId, decision) ?? Effect.void
    })

  const updateThread = (input: Parameters<typeof threads.update>[0]) =>
    threads.update(input).pipe(Effect.tap((thread) => push.publish({ type: "thread.updated", thread })))

  /**
   * Runs `effect` exclusively for the thread. Everything that changes a thread's transcript runs
   * under it, so `transcript` never observes a change without the push that announced it.
   */
  const exclusive =
    (threadId: string) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>) => {
      let lock = threadLocks.get(threadId)
      if (lock === undefined) threadLocks.set(threadId, (lock = Semaphore.makeUnsafe(1)))
      return Semaphore.withPermit(lock, effect)
    }

  const listSubagents = (threadId: string) => [...(subagents.get(threadId)?.values() ?? [])].toReversed()

  /** Sub-agent progress has its own push instead of the transcript, so it never lands in the chat. */
  const updateSubagent = (threadId: string, subagent: Subagent) => {
    let byId = subagents.get(threadId)
    if (byId === undefined) subagents.set(threadId, (byId = new Map()))
    byId.set(subagent.id, subagent)
    return push.publish({ type: "thread.subagents", threadId, subagents: listSubagents(threadId) })
  }

  /** Providers report sub-agents only during a turn, so one still running when the turn ends would never stop. */
  const stopSubagents = (threadId: string, endedAt: string) => {
    const byId = subagents.get(threadId)
    const running = [...(byId?.values() ?? [])].filter((subagent) => subagent.status === "running")
    if (byId === undefined || running.length === 0) return Effect.void
    for (const subagent of running) byId.set(subagent.id, { ...subagent, status: "stopped", endedAt })
    return push.publish({ type: "thread.subagents", threadId, subagents: listSubagents(threadId) })
  }

  const publishTranscript = (event: DistributiveOmit<TranscriptPush, "seq">) => push.publish({ ...event, seq: ++seq })

  const insertMessage = (message: Message) =>
    messages.insert(message).pipe(Effect.andThen(publishTranscript({ type: "message.created", message })))

  /**
   * One turn streaming into its assistant messages. A turn starts with one assistant message; each
   * steer closes it and opens another after the steer's user message, so ordering by createdAt keeps
   * the transcript in the order things happened.
   */
  const makeTurn = (
    thread: Thread,
    provider: AgentProvider,
    cwd: string,
    home: AccountHome | null,
    initial: Message,
    stop: Deferred.Deferred<void>,
  ) => {
    let turnMessages: ReadonlyArray<Message> = [initial]
    let status: ThreadStatus = "running"
    let completed = false
    let persistedAt = Date.now()
    let persistMs = 0
    const dirty = new Set<string>()

    const persist = Effect.suspend(() => {
      const changed = turnMessages.filter((message) => dirty.has(message.id))
      dirty.clear()
      persistedAt = Date.now()
      return Effect.forEach(changed, messages.update, { discard: true }).pipe(
        Effect.ensuring(Effect.sync(() => (persistMs = Date.now() - persistedAt))),
      )
    })

    const setTurnMessages = (next: ReadonlyArray<Message>) => {
      next.forEach((message, index) => message !== turnMessages[index] && dirty.add(message.id))
      turnMessages = next
    }

    const handle = (received: AgentEvent) =>
      Effect.gen(function* () {
        const event: AgentEvent =
          received.type === "tool_call_finished" ? { ...received, output: withoutImageData(received.output) } : received
        if (event.type === "subagent_updated") return yield* updateSubagent(thread.id, event.subagent)
        yield* publishTranscript({ type: "thread.event", threadId: thread.id, event })
        setTurnMessages(foldTranscript(turnMessages, event, yield* nowIso))

        if (event.type === "approval_requested") approvals.set(event.request.id, event.request)
        if (event.type === "approval_resolved") approvals.delete(event.requestId)
        if (event.type === "question_requested") questions.set(event.request.id, event.request)
        if (event.type === "question_resolved") questions.delete(event.requestId)
        if (event.type === "session_bound" && event.providerSessionId !== thread.providerSessionId) {
          yield* updateThread({ id: thread.id, providerSessionId: event.providerSessionId })
        }
        if (event.type === "turn_completed" || event.type === "turn_failed") completed = event.type === "turn_completed"
        const nextStatus = statusAfter(event)
        if (nextStatus !== undefined && nextStatus !== status) {
          status = nextStatus
          yield* updateThread({
            id: thread.id,
            status,
            ...(event.type === "turn_limited" ? { usageLimit: event.limit } : {}),
          })
        }
        const interval = Math.max(PERSIST_INTERVAL_MS, PERSIST_BACKOFF * persistMs)
        if (dirty.size > 0 && Date.now() - persistedAt >= interval) yield* persist
      }).pipe(exclusive(thread.id))

    const steer = (
      text: string,
      attachments: ReadonlyArray<Attachment>,
      when: Effect.Effect<boolean, PersistenceError>,
    ) =>
      Effect.gen(function* () {
        if (!(yield* when)) return false
        yield* provider.steer(thread.id, text, attachments)
        const now = yield* nowIso
        const current = turnMessages.at(-1)!
        const closed: Message = { ...current, completedAt: now }
        setTurnMessages(replaceLast(turnMessages, closed))
        yield* persist
        yield* publishTranscript({ type: "message.updated", message: closed })

        const next = openAssistantMessage(thread.id, now)
        yield* insertMessage(userMessage(thread.id, text, attachments, now))
        yield* insertMessage(next)
        turnMessages = [...turnMessages, next]
        return true
      }).pipe(exclusive(thread.id))

    let next: QueuedMessage | undefined
    /** Hands back the queued message that starts the next turn. The thread stays in `busyThreads` for it. */
    const finish = Effect.gen(function* () {
      for (const [id, request] of approvals) if (request.threadId === thread.id) approvals.delete(id)
      for (const [id, request] of questions) if (request.threadId === thread.id) questions.delete(id)
      for (const [id, { request, answer }] of secretRequests) {
        if (request.threadId !== thread.id) continue
        secretRequests.delete(id)
        yield* Deferred.fail(
          answer,
          new AgentError({ provider: "hinacode", message: "The turn ended before the user answered." }),
        )
      }
      yield* stopSubagents(thread.id, yield* nowIso)
      const last = turnMessages.at(-1)!
      if (last.completedAt === null) setTurnMessages(replaceLast(turnMessages, { ...last, completedAt: yield* nowIso }))
      yield* persist
      if (isThreadBusy(status)) yield* updateThread({ id: thread.id, status: "idle" })
      if (!completed || (yield* Deferred.isDone(stop))) return
      const [first, ...rest] = (yield* threads.get(thread.id)).queue
      if (first === undefined) return
      yield* updateThread({ id: thread.id, queue: rest })
      next = first
    }).pipe(
      Effect.catch((error) => Effect.logError("failed to finish turn", error)),
      Effect.ensuring(
        Effect.sync(() => {
          if (next === undefined) busyThreads.delete(thread.id)
          activeTurns.delete(thread.id)
        }),
      ),
      exclusive(thread.id),
      // Forked: the next turn takes this thread's slot in `turns`, which would interrupt the fiber running this.
      Effect.andThen(
        Effect.suspend(() => (next === undefined ? Effect.void : Effect.forkDetach(startQueued(thread.id, next)))),
      ),
    )

    /** Never fails: provider errors become turn_failed. */
    const follow = (events: Stream.Stream<AgentEvent, AgentError | PersistenceError>) =>
      Stream.runForEach(events, handle).pipe(
        Effect.catchTag("AgentError", (error) => handle({ type: "turn_failed", message: error.message })),
        Effect.catch((error) => Effect.logError("turn bookkeeping failed", error)),
        Effect.ensuring(finish),
      )

    const run = (prompt: string, attachments: ReadonlyArray<Attachment>) =>
      follow(
        Stream.unwrap(
          Effect.gen(function* () {
            const [mcpServer, { experimental, autoCompactTokens }] = yield* Effect.all([
              mcp.connectionFor(thread.id),
              settings.get,
            ])
            if (yield* Deferred.isDone(stop)) {
              return Stream.succeed<AgentEvent>({ type: "turn_failed", message: "Turn interrupted" })
            }
            return provider.runTurn({
              threadId: thread.id,
              prompt,
              attachments,
              cwd,
              model: thread.model,
              effort: thread.effort,
              fastMode: thread.fastMode,
              autoCompactTokens: autoCompactTokens[provider.id],
              userSkills: thread.userSkills,
              accessMode: thread.accessMode,
              resumeSessionId: thread.providerSessionId,
              home,
              mcpServer,
              instructions: agentInstructions(experimental),
            })
          }),
        ),
      )

    const interrupt = Effect.gen(function* () {
      yield* Deferred.succeed(stop, undefined)
      yield* provider.interrupt(thread.id)
    })

    return { provider, steer, run, follow, handle, interrupt, messages: () => turnMessages }
  }

  const nameThreadWithPullRequestScope = (thread: Thread, prompt: string) =>
    pullRequests.list(thread.id).pipe(
      Effect.flatMap((links) => naming.nameFromPrompt(thread, prompt, links.length === 0 ? "titleAndBranch" : "title")),
      Effect.catch((error) => Effect.logWarning("thread naming failed", error)),
    )

  const startTurn = (
    threadId: string,
    prompt: string,
    attachments: ReadonlyArray<Attachment>,
    options: SendOptions,
    stop: Deferred.Deferred<void>,
    when: Effect.Effect<boolean, PersistenceError>,
    sentToWorktreeId: string | null,
  ) =>
    Effect.gen(function* () {
      const checkStopped = Deferred.isDone(stop).pipe(
        Effect.flatMap((stopped) => (stopped ? Effect.fail(interruptedSend()) : Effect.void)),
      )
      const pending = yield* Effect.gen(function* () {
        yield* checkStopped
        if (!(yield* when)) return null
        let thread = yield* threads.get(threadId)
        const first = !(yield* threads.started(threadId))
        if (options.workspace) {
          const prepared = yield* threads.prepareWorkspace(threadId, options.workspace)
          thread = prepared.thread
          yield* push.publish({ type: "thread.updated", thread })
          if (prepared.pullRequestUrl !== null) yield* pullRequests.link(threadId, prepared.pullRequestUrl)
        }
        return { first, worktreeId: thread.worktreeId }
      }).pipe(exclusive(threadId))
      if (pending === null) return false

      if (pending.worktreeId !== null) {
        yield* Effect.raceFirst(
          worktrees.whenPrepared(pending.worktreeId),
          Deferred.await(stop).pipe(Effect.andThen(Effect.fail(interruptedSend()))),
        )
      }

      return yield* Effect.gen(function* () {
        const admitted = yield* worktrees.exclusive(
          Effect.gen(function* () {
            yield* checkStopped
            if (!(yield* when)) return null
            const thread = yield* threads.get(threadId)
            if (thread.status === "archived") {
              return yield* new AgentError({ provider: "hinacode", message: "Cannot send to an archived thread" })
            }
            const provider = yield* providerFor(thread.provider)
            const home = yield* accounts.home(thread.accountId)
            const { cwd, worktreeId } = yield* activeWorkspace(threadId)
            if (sentToWorktreeId !== null && worktreeId !== sentToWorktreeId) {
              return yield* new AgentError({
                provider: "hinacode",
                message: "This thread's worktree was removed before the turn started",
              })
            }
            const tree = yield* threads.captureTurnBase(cwd)
            yield* checkStopped
            if (!(yield* when)) return null
            yield* threads.recordTurnBase({ threadId, tree })
            const now = yield* nowIso
            const assistant = openAssistantMessage(threadId, now)
            yield* insertMessage(userMessage(threadId, prompt, attachments, now))
            yield* insertMessage(assistant)
            yield* updateThread({ id: threadId, status: "running" })
            return { thread, turn: makeTurn(thread, provider, cwd, home, assistant, stop) }
          }),
        )
        if (admitted === null) return false
        const { thread: currentThread, turn } = admitted
        activeTurns.set(threadId, turn)
        pendingSends.delete(threadId)
        yield* FiberMap.run(turns, threadId, turn.run(prompt, attachments))
        if (pending.first && currentThread.createdBy === "user" && prompt.trim() !== "")
          yield* Effect.forkDetach(nameThreadWithPullRequestScope(currentThread, prompt))
        return true
      }).pipe(exclusive(threadId))
    })

  /** Starts a turn for a thread the caller already added to `busyThreads`. */
  const startClaimed = (
    threadId: string,
    prompt: string,
    attachments: ReadonlyArray<Attachment>,
    options: SendOptions,
    when: Effect.Effect<boolean, PersistenceError>,
  ): Effect.Effect<boolean, SendError> =>
    Effect.gen(function* () {
      const stop = Deferred.makeUnsafe<void>()
      pendingSends.set(threadId, stop)
      const accepted = yield* activeWorkspace(threadId).pipe(
        Effect.flatMap(({ worktreeId }) => startTurn(threadId, prompt, attachments, options, stop, when, worktreeId)),
        Effect.onError(() => Effect.sync(() => busyThreads.delete(threadId))),
        Effect.ensuring(Effect.sync(() => pendingSends.get(threadId) === stop && pendingSends.delete(threadId))),
      )
      if (!accepted) busyThreads.delete(threadId)
      return accepted
    })

  const sendWhen = (
    threadId: string,
    prompt: string,
    attachments: ReadonlyArray<Attachment>,
    options: SendOptions,
    when: Effect.Effect<boolean, PersistenceError>,
  ): Effect.Effect<boolean, SendError> =>
    Effect.gen(function* () {
      if (busyThreads.has(threadId)) {
        return yield* new AgentError({ provider: "hinacode", message: "A turn is already running on this thread" })
      }
      busyThreads.add(threadId)
      return yield* startClaimed(threadId, prompt, attachments, options, when)
    })

  const send = (threadId: string, prompt: string, attachments: ReadonlyArray<Attachment>, options: SendOptions = {}) =>
    sendWhen(threadId, prompt, attachments, options, Effect.succeed(true)).pipe(Effect.asVoid)

  const queue = (threadId: string, text: string, attachments: ReadonlyArray<Attachment>) =>
    Effect.gen(function* () {
      const queued = yield* Effect.gen(function* () {
        if (!busyThreads.has(threadId)) return false
        const thread = yield* threads.get(threadId)
        yield* updateThread({ id: threadId, queue: [...thread.queue, { id: randomUUID(), text, attachments }] })
        return true
      }).pipe(exclusive(threadId))
      if (!queued) yield* send(threadId, text, attachments)
    })

  const unqueue = (threadId: string, id: string) =>
    Effect.gen(function* () {
      const thread = yield* threads.get(threadId)
      const message = thread.queue.find((queued) => queued.id === id)
      if (message === undefined) return null
      yield* updateThread({ id: threadId, queue: thread.queue.filter((queued) => queued.id !== id) })
      return message
    }).pipe(exclusive(threadId))

  /** A queued message that cannot start its turn goes back to the front, so the user can still send it. */
  const startQueued = (threadId: string, message: QueuedMessage) =>
    startClaimed(threadId, message.text, message.attachments, {}, Effect.succeed(true)).pipe(
      Effect.asVoid,
      Effect.catch((error) =>
        Effect.gen(function* () {
          yield* Effect.logWarning("queued message did not start", error)
          const thread = yield* threads.get(threadId)
          yield* updateThread({ id: threadId, queue: [message, ...thread.queue] })
        }).pipe(
          exclusive(threadId),
          Effect.catch((cause) => Effect.logError("failed to put back a queued message", cause)),
        ),
      ),
    )

  const steerWhen: typeof AgentRunner.Service.steerWhen = ({ threadId, text, attachments, when }) =>
    Effect.suspend(
      () =>
        activeTurns.get(threadId)?.steer(text, attachments, when) ?? sendWhen(threadId, text, attachments, {}, when),
    )

  // The provider's reset time is rounded and its clock drifts from ours; resuming on the dot can hit the limit again.
  const resumeGraceMs = 60_000

  const resumeAtReset = (threadId: string, enabled: boolean) =>
    Effect.gen(function* () {
      const thread = yield* threads.get(threadId)
      const limit = thread.usageLimit
      if (thread.status !== "limited" || limit === null || limit.reset === null) {
        return yield* new AgentError({ provider: thread.provider, message: "This limit has no automatic reset" })
      }
      return yield* updateThread({
        id: threadId,
        usageLimit: { ...limit, reset: { ...limit.reset, autoResume: enabled } },
      })
    }).pipe(exclusive(threadId))

  const consumeDueResume = (threadId: string, now: string) =>
    Effect.gen(function* () {
      const thread = yield* threads.get(threadId)
      const limit = thread.usageLimit
      if (
        busyThreads.has(thread.id) ||
        thread.status !== "limited" ||
        limit === null ||
        !limit.reset?.autoResume ||
        Date.parse(limit.reset.at) + resumeGraceMs > Date.parse(now)
      )
        return
      yield* updateThread({ id: thread.id, usageLimit: { ...limit, reset: { ...limit.reset, autoResume: false } } })
      return yield* lastPrompt(thread.id)
    }).pipe(exclusive(threadId))

  const lastPrompt = (threadId: string) =>
    messages.list(threadId).pipe(Effect.map((list) => list.findLast((message) => message.role === "user")))

  const resend = (threadId: string, prompt: Message) =>
    send(
      threadId,
      prompt.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n"),
      prompt.parts.flatMap((part) => (part.type === "attachment" ? [part.attachment] : [])),
    )

  const resumeDue = Effect.gen(function* () {
    const now = yield* nowIso
    for (const candidate of yield* threads.list) {
      yield* Effect.gen(function* () {
        const prompt = yield* consumeDueResume(candidate.id, now)
        if (prompt !== undefined) yield* resend(candidate.id, prompt)
      }).pipe(Effect.catch((error) => Effect.logWarning("automatic resume failed", error)))
    }
  })

  const switchAccount: typeof AgentRunner.Service.switchAccount = (threadId, accountId, options) =>
    Effect.gen(function* () {
      const switched = yield* Effect.gen(function* () {
        if (busyThreads.has(threadId)) {
          return yield* new AgentError({ provider: "hinacode", message: "Wait for the turn to end to switch accounts" })
        }
        const current = yield* threads.get(threadId)
        if (accountId === current.accountId) return { thread: current, prompt: undefined }
        if (accountId !== null && (yield* accounts.get(accountId)).provider !== current.provider) {
          return yield* new NotFoundError({ entity: "account", id: accountId })
        }
        if (current.providerSessionId !== null) {
          const provider = providers[current.provider]
          if (provider.copySession === undefined) return yield* new ThreadStartedError({ id: threadId })
          yield* provider.copySession(
            current.providerSessionId,
            yield* accounts.home(current.accountId),
            yield* accounts.home(accountId),
          )
        }
        const thread = yield* updateThread({
          id: threadId,
          accountId,
          ...(current.status === "limited" && { status: "idle" }),
        })
        return { thread, prompt: options.resend ? yield* lastPrompt(threadId) : undefined }
      }).pipe(exclusive(threadId))
      if (switched.prompt !== undefined) yield* resend(threadId, switched.prompt)
      return switched.thread
    })

  yield* resumeDue.pipe(
    Effect.catch((error) => Effect.logWarning("limit reset check failed", error)),
    Effect.repeat(Schedule.spaced("1 second")),
    Effect.forkIn(scope),
  )

  /**
   * A turn the agent started by itself, with no user message before its reply. It waits for a turn that
   * was already starting, which the provider turns away since this one holds the session.
   */
  const startWake = ({ threadId, events, discard }: Wake) =>
    Effect.suspend(() => {
      let claimed = false
      let adopted = false
      return Effect.gen(function* () {
        while (busyThreads.has(threadId)) yield* Effect.sleep("50 millis")
        busyThreads.add(threadId)
        claimed = true
        const turn = yield* Effect.gen(function* () {
          const thread = yield* threads.get(threadId)
          if (thread.status === "archived") return null
          const provider = yield* providerFor(thread.provider)
          const home = yield* accounts.home(thread.accountId)
          const { cwd } = yield* activeWorkspace(threadId)
          const assistant = openAssistantMessage(threadId, yield* nowIso)
          yield* insertMessage(assistant)
          yield* updateThread({ id: threadId, status: "running" })
          return makeTurn(thread, provider, cwd, home, assistant, Deferred.makeUnsafe<void>())
        }).pipe(worktrees.exclusive, exclusive(threadId))
        if (turn === null) return
        activeTurns.set(threadId, turn)
        yield* FiberMap.run(turns, threadId, turn.follow(events))
        adopted = true
      }).pipe(
        Effect.ensuring(
          Effect.suspend(() => {
            if (adopted) return Effect.void
            if (claimed) busyThreads.delete(threadId)
            return discard
          }),
        ),
      )
    })

  for (const provider of Object.values(providers)) {
    if (provider.wakes === undefined) continue
    yield* Effect.forkIn(
      Stream.runForEach(provider.wakes, (wake) =>
        Effect.forkIn(
          startWake(wake).pipe(Effect.catch((error) => Effect.logWarning("agent-started turn did not open", error))),
          scope,
        ),
      ),
      scope,
    )
  }

  for (const provider of Object.values(providers)) {
    if (provider.backgroundTasks === undefined) continue
    yield* Effect.forkIn(
      Stream.runForEach(provider.backgroundTasks.changes, ({ threadId, tasks }) => {
        if (tasks.length === 0) backgroundTasks.delete(threadId)
        else backgroundTasks.set(threadId, tasks)
        return push.publish({ type: "thread.backgroundTasks", threadId, tasks })
      }),
      scope,
    )
  }

  const requestSecret = (threadId: string, name: string, description: string) =>
    Effect.gen(function* () {
      const turn = activeTurns.get(threadId)
      if (turn === undefined) {
        return yield* new AgentError({ provider: "hinacode", message: "No turn is running on this thread." })
      }
      const request: SecretRequest = { id: randomUUID(), threadId, name, description }
      const answer = yield* Deferred.make<"stored" | "declined", AgentError>()
      secretRequests.set(request.id, { request, answer })
      yield* turn.handle({ type: "secret_requested", request })
      return yield* Deferred.await(answer).pipe(
        // The agent gave up waiting (disconnected, timed out): take the card away.
        Effect.onInterrupt(() => resolveSecret(request.id)),
      )
    })

  /** Forgets the request and tells the renderer, if its turn is still around to carry the event. */
  const resolveSecret = (requestId: string) =>
    Effect.suspend(() => {
      const pending = secretRequests.get(requestId)
      if (pending === undefined) return Effect.void
      secretRequests.delete(requestId)
      const turn = activeTurns.get(pending.request.threadId)
      return turn?.handle({ type: "secret_resolved", requestId }) ?? Effect.void
    })

  const respondSecret = (requestId: string, value: string | null) =>
    Effect.gen(function* () {
      const pending = secretRequests.get(requestId)
      if (pending === undefined) return
      if (value !== null) yield* secrets.set(pending.request.name, value)
      yield* resolveSecret(requestId)
      yield* Deferred.succeed(pending.answer, value === null ? "declined" : "stored")
    })

  return AgentRunner.of({
    send,
    queue,
    unqueue,
    resumeAtReset,
    switchAccount,
    steer: (threadId, text, attachments) =>
      steerWhen({ threadId, text, attachments, when: Effect.succeed(true) }).pipe(Effect.asVoid),
    steerWhen,
    interrupt: (threadId) =>
      Effect.suspend(() => {
        const turn = activeTurns.get(threadId)
        if (turn !== undefined) return turn.interrupt
        const pending = pendingSends.get(threadId)
        return pending === undefined ? Effect.void : Deferred.succeed(pending, undefined).pipe(Effect.asVoid)
      }),
    // Switching the mode does not answer a tool call already waiting for approval, so full access allows it here.
    setAccessMode: (threadId, accessMode) =>
      Effect.gen(function* () {
        const turn = activeTurns.get(threadId)
        if (turn === undefined) return
        yield* turn.provider.setAccessMode(threadId, accessMode)
        if (accessMode !== "full") return
        for (const request of approvals.values()) {
          if (request.threadId === threadId) yield* respondApproval(request.id, "allow")
        }
      }),
    respondApproval,
    respondQuestion: (requestId, answers) =>
      Effect.suspend(() => {
        const request = questions.get(requestId)
        if (request === undefined) return Effect.void
        return providers[request.provider].respondQuestion(requestId, answers)
      }),
    requestSecret,
    respondSecret,
    // The database lags a running turn by a persist interval or more, so its messages come from memory.
    transcript: (threadId) =>
      Effect.gen(function* () {
        const persisted = yield* messages.list(threadId)
        const live = new Map(
          activeTurns
            .get(threadId)
            ?.messages()
            .map((message) => [message.id, message]),
        )
        return {
          messages: persisted.map((message) => live.get(message.id) ?? message),
          approvals: [...approvals.values()].filter((request) => request.threadId === threadId),
          questions: [...questions.values()].filter((request) => request.threadId === threadId),
          secretRequests: [...secretRequests.values()]
            .map(({ request }) => request)
            .filter((request) => request.threadId === threadId),
          seq,
        }
      }).pipe(exclusive(threadId)),
    listModels: (id) => providers[id]?.listModels ?? Effect.succeed([]),
    limits: Effect.gen(function* () {
      const added = yield* accounts.list
      const keys = Object.values(providers).flatMap(({ id }): ReadonlyArray<LimitsKey> => [
        { provider: id, accountId: null },
        ...added
          .filter((account) => account.provider === id)
          .map((account) => ({ provider: id, accountId: account.id })),
      ])
      return yield* Effect.forEach(keys, (key) => Cache.get(cachedLimits, JSON.stringify(key)), {
        concurrency: "unbounded",
      })
    }),
    usage: (threadId) =>
      Effect.gen(function* () {
        const thread = yield* threads.get(threadId)
        if (thread.providerSessionId === null) return null
        const home = yield* accounts.home(thread.accountId)
        return yield* providers[thread.provider].usage(thread.providerSessionId, home)
      }),
    subagents: (threadId) => Effect.sync(() => listSubagents(threadId)),
    stopSubagent: (threadId, subagentId) =>
      Effect.gen(function* () {
        if (subagents.get(threadId)?.get(subagentId)?.status !== "running") return
        const { provider: id } = yield* threads.get(threadId)
        const stop = providers[id].stopSubagent
        if (stop === undefined) {
          return yield* new AgentError({ provider: id, message: "This agent cannot stop a single sub-agent" })
        }
        yield* stop(threadId, subagentId)
        // The provider's own report of the stop can arrive with no turn left to carry it.
        const endedAt = yield* nowIso
        const latest = subagents.get(threadId)?.get(subagentId)
        if (latest?.status === "running") yield* updateSubagent(threadId, { ...latest, status: "stopped", endedAt })
      }),
    backgroundTasks: (threadId) => Effect.sync(() => backgroundTasks.get(threadId) ?? []),
    stopBackgroundTask: (threadId, taskId) =>
      Effect.gen(function* () {
        const { provider: id } = yield* threads.get(threadId)
        const tasks = providers[id].backgroundTasks
        if (tasks === undefined) {
          return yield* new AgentError({ provider: id, message: "This agent cannot stop a background task" })
        }
        yield* tasks.stop(threadId, taskId)
      }),
    listCommands: (threadId) =>
      Effect.gen(function* () {
        const thread = yield* threads.get(threadId)
        const { cwd } = yield* activeWorkspace(threadId)
        const home = yield* accounts.home(thread.accountId)
        return yield* providers[thread.provider].listCommands({ threadId, cwd, home })
      }),
  })
})

export const layer = Layer.effect(AgentRunner, make)
