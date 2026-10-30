import { randomUUID } from "node:crypto"
import {
  Cache,
  Context,
  Deferred,
  Duration,
  Effect,
  FiberMap,
  Layer,
  Option,
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
  ContextBreakdown,
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
import { handoffPrompt } from "../agents/handoff.ts"
import { agentInstructions, type AgentEnvironment } from "../agents/instructions.ts"
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
import { Git, type CommandError } from "./Git.ts"
import type { GitHubError, PullRequestUrlInvalidError } from "./GitHub.ts"
import { Messages } from "./Messages.ts"
import { PullRequests } from "./PullRequests.ts"
import { Scratch } from "./Scratch.ts"
import { Settings } from "./Settings.ts"
import { ThreadNaming } from "./ThreadNaming.ts"
import { Threads, type UpdateThread } from "./Threads.ts"
import { Worktrees } from "./Worktrees.ts"
import { AgentAccounts } from "./AgentAccounts.ts"
import { type ActiveWorkspace, makeActiveWorkspace } from "./workspace.ts"

const PERSIST_INTERVAL_MS = 500
const PERSIST_BACKOFF = 10
const interruptedSend = () => new AgentError({ provider: "hinacode", message: "Message send interrupted" })

export interface SendOptions {
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
    readonly send: (
      threadId: string,
      prompt: string,
      attachments: ReadonlyArray<Attachment>,
      options?: SendOptions,
    ) => Effect.Effect<void, SendError>
    readonly steer: (
      threadId: string,
      text: string,
      attachments: ReadonlyArray<Attachment>,
    ) => Effect.Effect<void, SendError>
    readonly queue: (
      threadId: string,
      text: string,
      attachments: ReadonlyArray<Attachment>,
    ) => Effect.Effect<void, SendError>
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
    readonly switchAccount: (
      threadId: string,
      accountId: string | null,
      options: { readonly resend: boolean },
    ) => Effect.Effect<Thread, SendError>
    readonly switchAgent: (input: UpdateThread & { readonly provider: ProviderId }) => Effect.Effect<Thread, SendError>
    readonly setAccessMode: (threadId: string, accessMode: AccessMode) => Effect.Effect<void, AgentError>
    readonly respondApproval: (requestId: string, decision: ApprovalDecision) => Effect.Effect<void>
    readonly respondQuestion: (requestId: string, answers: QuestionAnswers) => Effect.Effect<void>
    readonly requestSecret: (
      threadId: string,
      name: string,
      description: string,
    ) => Effect.Effect<Option.Option<string>, AgentError | PersistenceError | NotFoundError | ThreadStartedError>
    readonly respondSecret: (
      requestId: string,
      value: string | null,
    ) => Effect.Effect<void, PersistenceError | NotFoundError | ThreadStartedError>
    readonly transcript: (threadId: string) => Effect.Effect<RpcResponse<"threads.transcript">, PersistenceError>
    readonly listModels: (provider: ProviderId) => Effect.Effect<ReadonlyArray<ModelInfo>, AgentError>
    readonly limits: Effect.Effect<ReadonlyArray<AccountLimits>, PersistenceError>
    readonly usage: (
      threadId: string,
    ) => Effect.Effect<ThreadUsage | null, AgentError | PersistenceError | NotFoundError>
    readonly contextBreakdown: (
      threadId: string,
    ) => Effect.Effect<ContextBreakdown | null, AgentError | PersistenceError | NotFoundError>
    readonly subagents: (threadId: string) => Effect.Effect<ReadonlyArray<Subagent>>
    readonly stopSubagent: (
      threadId: string,
      subagentId: string,
    ) => Effect.Effect<void, AgentError | PersistenceError | NotFoundError>
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
  forkPoint: null,
})

const openAssistantMessage = (threadId: string, now: string): Message => ({
  id: randomUUID(),
  threadId,
  role: "assistant",
  parts: [],
  createdAt: now,
  completedAt: null,
  usage: null,
  forkPoint: null,
})

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

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
  const scratch = yield* Scratch
  const git = yield* Git
  const pullRequests = yield* PullRequests
  const messages = yield* Messages
  const push = yield* Events
  const mcp = yield* McpCredentials
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
    { readonly request: SecretRequest; readonly answer: Deferred.Deferred<Option.Option<string>, AgentError> }
  >()
  const threadLocks = new Map<string, Semaphore.Semaphore>()
  const subagents = new Map<string, Map<string, Subagent>>()
  const backgroundTasks = new Map<string, ReadonlyArray<BackgroundTask>>()
  let seq = 0

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

  const exclusive =
    (threadId: string) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>) => {
      let lock = threadLocks.get(threadId)
      if (lock === undefined) threadLocks.set(threadId, (lock = Semaphore.makeUnsafe(1)))
      return Semaphore.withPermit(lock, effect)
    }

  const listSubagents = (threadId: string) => [...(subagents.get(threadId)?.values() ?? [])].toReversed()

  const updateSubagent = (threadId: string, subagent: Subagent) => {
    let byId = subagents.get(threadId)
    if (byId === undefined) subagents.set(threadId, (byId = new Map()))
    byId.set(subagent.id, subagent)
    return push.publish({ type: "thread.subagents", threadId, subagents: listSubagents(threadId) })
  }

  const stopSubagents = (threadId: string, endedAt: string) => {
    const byId = subagents.get(threadId)
    const running = [...(byId?.values() ?? [])].filter((subagent) => subagent.status === "running")
    if (byId === undefined || running.length === 0) return Effect.void
    for (const subagent of running) byId.set(subagent.id, { ...subagent, status: "stopped", endedAt })
    return push.publish({ type: "thread.subagents", threadId, subagents: listSubagents(threadId) })
  }

  const publishTranscript = (event: DistributiveOmit<TranscriptPush, "seq">) => push.publish({ ...event, seq: ++seq })

  const gitOutput = (cwd: string, args: ReadonlyArray<string>) =>
    git.run(cwd, args).pipe(
      Effect.map((out) => out.trim() || null),
      Effect.orElseSucceed(() => null),
    )

  const readEnvironment = (thread: Thread, { cwd, rootPath }: ActiveWorkspace) =>
    Effect.all(
      [
        gitOutput(cwd, ["rev-parse", "--is-inside-work-tree"]),
        gitOutput(cwd, ["branch", "--show-current"]),
        gitOutput(cwd, ["remote", "get-url", "origin"]),
        scratch.ensure(thread),
      ],
      { concurrency: "unbounded" },
    ).pipe(
      Effect.map(([insideWorkTree, branch, remote, scratchDirectory]): AgentEnvironment => ({
        gitRepository: insideWorkTree === "true",
        branch,
        cwd,
        rootPath,
        remote,
        platform: process.platform,
        scratchDirectory,
      })),
    )

  const insertMessage = (message: Message) =>
    messages.insert(message).pipe(Effect.andThen(publishTranscript({ type: "message.created", message })))

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
          received.type === "tool_call_finished"
            ? { ...received, output: withoutImageData(received.output) }
            : received.type === "turn_completed" && received.forkPoint !== undefined
              ? {
                  ...received,
                  forkPoint: { ...received.forkPoint, owner: { provider: provider.id, accountId: thread.accountId } },
                }
              : received
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
    const withdraw = (event: AgentEvent) => publishTranscript({ type: "thread.event", threadId: thread.id, event })
    const finish = Effect.gen(function* () {
      for (const [id, request] of approvals) {
        if (request.threadId !== thread.id) continue
        approvals.delete(id)
        yield* withdraw({ type: "approval_resolved", requestId: id })
      }
      for (const [id, request] of questions) {
        if (request.threadId !== thread.id) continue
        questions.delete(id)
        yield* withdraw({ type: "question_resolved", requestId: id })
      }
      for (const [id, { request, answer }] of secretRequests) {
        if (request.threadId !== thread.id) continue
        secretRequests.delete(id)
        yield* withdraw({ type: "secret_resolved", requestId: id })
        yield* Deferred.fail(
          answer,
          new AgentError({ provider: "hinacode", message: "The turn ended before the user answered." }),
        )
      }
      yield* stopSubagents(thread.id, yield* nowIso)
      const last = turnMessages.at(-1)!
      const closed: Message = last.completedAt === null ? { ...last, completedAt: yield* nowIso } : last
      setTurnMessages(replaceLast(turnMessages, closed))
      yield* persist
      if (closed !== last) yield* publishTranscript({ type: "message.updated", message: closed })
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
      Effect.andThen(
        Effect.suspend(() => (next === undefined ? Effect.void : Effect.forkDetach(startQueued(thread.id, next)))),
      ),
    )

    const follow = (events: Stream.Stream<AgentEvent, AgentError | PersistenceError>) =>
      Stream.runForEach(events, handle).pipe(
        Effect.catchTag("AgentError", (error) => handle({ type: "turn_failed", message: error.message })),
        Effect.catch((error) => Effect.logError("turn bookkeeping failed", error)),
        Effect.ensuring(finish),
      )

    const run = (prompt: string, attachments: ReadonlyArray<Attachment>, environment: AgentEnvironment) =>
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
              resumeSessionId: thread.providerSessionId ?? thread.forkedFrom?.sessionId ?? null,
              forkAt: thread.providerSessionId === null ? (thread.forkedFrom?.checkpoint ?? null) : null,
              home,
              mcpServer,
              instructions: agentInstructions(experimental, environment),
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

  const promptForSession = (thread: Thread, prompt: string) =>
    Effect.gen(function* () {
      if (thread.providerSessionId !== null || thread.forkedFrom !== null) return prompt
      const history = yield* messages.list(thread.id)
      if (history.length === 0) return prompt
      const lastSwitch = history.flatMap((message) => message.parts).findLast((part) => part.type === "agent_switch")
      const from = lastSwitch?.type === "agent_switch" ? lastSwitch.from : thread.provider
      return handoffPrompt({ messages: history, from, to: thread.provider, prompt })
    })

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
            const workspace = yield* activeWorkspace(threadId)
            const { cwd, worktreeId } = workspace
            if (sentToWorktreeId !== null && worktreeId !== sentToWorktreeId) {
              return yield* new AgentError({
                provider: "hinacode",
                message: "This thread's worktree was removed before the turn started",
              })
            }
            const [tree, environment] = yield* Effect.all(
              [threads.captureTurnBase(cwd), readEnvironment(thread, workspace)],
              {
                concurrency: "unbounded",
              },
            )
            yield* checkStopped
            if (!(yield* when)) return null
            yield* threads.recordTurnBase({ threadId, tree })
            const agentPrompt = yield* promptForSession(thread, prompt)
            const now = yield* nowIso
            const assistant = openAssistantMessage(threadId, now)
            yield* insertMessage(userMessage(threadId, prompt, attachments, now))
            yield* insertMessage(assistant)
            yield* updateThread({ id: threadId, status: "running" })
            return { thread, environment, agentPrompt, turn: makeTurn(thread, provider, cwd, home, assistant, stop) }
          }),
        )
        if (admitted === null) return false
        const { thread: currentThread, environment, agentPrompt, turn } = admitted
        activeTurns.set(threadId, turn)
        pendingSends.delete(threadId)
        yield* FiberMap.run(turns, threadId, turn.run(agentPrompt, attachments, environment))
        if (pending.first && currentThread.createdBy === "user" && prompt.trim() !== "")
          yield* Effect.forkDetach(nameThreadWithPullRequestScope(currentThread, prompt))
        return true
      }).pipe(exclusive(threadId))
    })

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

  // FIXME: providers round their reset time and their clock drifts from ours
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
        const sessionId = current.providerSessionId ?? current.forkedFrom?.sessionId ?? null
        if (sessionId !== null) {
          const provider = providers[current.provider]
          if (provider.copySession === undefined) return yield* new ThreadStartedError({ id: threadId })
          yield* provider.copySession(
            sessionId,
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

  const switchAgent: typeof AgentRunner.Service.switchAgent = (input) =>
    Effect.gen(function* () {
      if (busyThreads.has(input.id)) {
        return yield* new AgentError({ provider: "hinacode", message: "Wait for the turn to end to switch agents" })
      }
      const current = yield* threads.get(input.id)
      if (input.provider === current.provider) return yield* threads.update(input)
      const closeSession = providers[current.provider].closeSession
      if (closeSession !== undefined) yield* closeSession(current.id, yield* accounts.home(current.accountId))
      const started = yield* threads.started(input.id)
      const thread = yield* threads.update(input)
      if (started) {
        const now = yield* nowIso
        yield* insertMessage({
          id: randomUUID(),
          threadId: thread.id,
          role: "assistant",
          parts: [{ type: "agent_switch", from: current.provider, to: thread.provider }],
          createdAt: now,
          completedAt: now,
          usage: null,
          forkPoint: null,
        })
      }
      return thread
    }).pipe(exclusive(input.id))

  yield* resumeDue.pipe(
    Effect.catch((error) => Effect.logWarning("limit reset check failed", error)),
    Effect.repeat(Schedule.spaced("1 second")),
    Effect.forkIn(scope),
  )

  const startWake = (source: AgentProvider, { threadId, sessionId, events, discard }: Wake) =>
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
          if (thread.provider !== source.id || thread.providerSessionId !== sessionId) return null
          const home = yield* accounts.home(thread.accountId)
          const { cwd } = yield* activeWorkspace(threadId)
          const assistant = openAssistantMessage(threadId, yield* nowIso)
          yield* insertMessage(assistant)
          yield* updateThread({ id: threadId, status: "running" })
          return makeTurn(thread, source, cwd, home, assistant, Deferred.makeUnsafe<void>())
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
          startWake(provider, wake).pipe(
            Effect.catch((error) => Effect.logWarning("agent-started turn did not open", error)),
          ),
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
      const answer = yield* Deferred.make<Option.Option<string>, AgentError>()
      secretRequests.set(request.id, { request, answer })
      yield* turn.handle({ type: "secret_requested", request })
      return yield* Deferred.await(answer).pipe(Effect.onInterrupt(() => resolveSecret(request.id)))
    })

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
      const { threadId, name } = pending.request
      const path =
        value === null
          ? Option.none()
          : Option.some(yield* scratch.writeSecret(yield* threads.get(threadId), name, value))
      yield* resolveSecret(requestId)
      yield* Deferred.succeed(pending.answer, path)
    })

  return AgentRunner.of({
    send,
    queue,
    unqueue,
    resumeAtReset,
    switchAccount,
    switchAgent,
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
    contextBreakdown: (threadId) =>
      Effect.gen(function* () {
        const { provider: id } = yield* threads.get(threadId)
        const read = providers[id].contextBreakdown
        return read === undefined ? null : yield* read(threadId)
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
