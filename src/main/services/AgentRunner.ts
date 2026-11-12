import { randomUUID } from "node:crypto"
import {
  Cache,
  Clock,
  Context,
  Deferred,
  Duration,
  Effect,
  Fiber,
  FiberMap,
  Layer,
  Option,
  Predicate,
  Record,
  type Schema,
  Semaphore,
  Stream,
} from "effect"
import { SqlClient } from "effect/sql"
import { type RpcResponse, type TranscriptPush, transcriptThreadId } from "../../shared/contract.ts"
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
import { WAIT_AGENT_TOOL } from "../../shared/agent.ts"
import type {
  AccessMode,
  Attachment,
  ExperimentalSettings,
  Message,
  QueuedMessage,
  ScheduledMessage,
  Thread,
  ThreadStatus,
  WorkspaceChoice,
} from "../../shared/domain.ts"
import { enabledProviders, isThreadBusy, spawnsSubagent } from "../../shared/domain.ts"
import { previewPush } from "../../shared/compactTranscript.ts"
import { foldTranscript } from "../../shared/foldEvent.ts"
import { resumeGraceMs } from "../../shared/limits.ts"
import { expandArtifactSkill } from "../agents/artifactSkills.ts"
import { ClaudeProvider } from "../agents/claude/index.ts"
import { CodexProvider } from "../agents/codex/index.ts"
import { expandDocumentCommand, withDocumentCommand } from "../agents/document.ts"
import { handoffPrompt } from "../agents/handoff.ts"
import { latestForkPoint, sidechatPrompt, unseenSince } from "../agents/sidechat.ts"
import { agentInstructions, type AgentEnvironment } from "../agents/instructions.ts"
import { pickedSubagentModel, spawningCallId, subagentChoices } from "../agents/runAgent.ts"
import { subagentReport } from "../agents/subagentReport.ts"
import { providerInfo } from "../../shared/providers.ts"
import { MuseProvider } from "../agents/muse/index.ts"
import { MagpieProvider } from "../agents/magpie/index.ts"
import { OpencodeProvider } from "../agents/opencode/index.ts"
import { McpCredentials } from "../mcp/credentials.ts"
import {
  AgentError,
  type AgentProvider,
  interruptedTurn,
  type SessionInput,
  type SteerPriority,
  type SubagentChange,
  type Wake,
} from "../agents/provider.ts"
import { Events } from "./Events.ts"
import { nowIso } from "./clock.ts"
import { type Deadline, earliest, runAtDeadlines } from "./deadlines.ts"
import { makeDeltaCoalescer } from "./coalesceDeltas.ts"
import {
  type FolderMissingError,
  NotFoundError,
  AccountInUseError,
  type PersistenceError,
  persistence,
  type PullRequestElsewhereError,
  type RootBusyError,
  ThreadStartedError,
  type WorktreeTakenError,
} from "./errors.ts"
import { Git, type CommandError } from "./Git.ts"
import type { GitHubError, PullRequestUrlInvalidError } from "./GitHub.ts"
import { Messages, type ToolCallRef } from "./Messages.ts"
import { PullRequests } from "./PullRequests.ts"
import { Attachments, extensionForMime } from "./Attachments.ts"
import { Scratch } from "./Scratch.ts"
import { Settings } from "./Settings.ts"
import { ThreadNaming } from "./ThreadNaming.ts"
import { Projects } from "./Projects.ts"
import { Threads, type UpdateThread } from "./Threads.ts"
import { Worktrees } from "./Worktrees.ts"
import { AgentAccounts } from "./AgentAccounts.ts"
import { type ActiveWorkspace, makeActiveWorkspace } from "./workspace.ts"

const PERSIST_INTERVAL_MS = 500
const RUN_AGENT_WAIT = Duration.minutes(4)
const PERSIST_BYTES_PER_SECOND = 256 * 1024
const interruptedSend = () => new AgentError({ provider: "hinacode", message: "Message send interrupted" })

interface AgentRequest {
  readonly provider: ProviderId
  readonly description: string
  readonly prompt: string
  readonly model?: string | undefined
  readonly effort?: string | undefined
}

interface QueueOptions {
  readonly messageId?: string | undefined
  readonly when?: Effect.Effect<boolean, PersistenceError> | undefined
}

interface SendOptions {
  readonly workspace?: WorkspaceChoice | undefined
  readonly scheduledId?: string | undefined
  readonly messageId?: string | undefined
}

type SendError =
  | AgentError
  | FolderMissingError
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

export const RESUME_PROMPT = [
  "HinaCode restarted while you were working, so your last turn stopped partway.",
  "Before you continue, run `git status` and `git log` in your workspace to see what you already changed and committed.",
  "Then carry on with the task.",
].join(" ")

const resumeAt = (thread: Thread): Deadline => {
  const reset = thread.usageLimit?.reset
  if (thread.status !== "limited" || reset?.autoResume !== true) return undefined
  return Date.parse(reset.at) + resumeGraceMs
}

const resumeIsDue = (thread: Thread, now: string) => (resumeAt(thread) ?? Infinity) <= Date.parse(now)

const deliveryAt = (message: ScheduledMessage): Deadline =>
  message.failure === undefined ? Date.parse(message.sendAt) : undefined

const isDue = (message: ScheduledMessage, now: string) => (deliveryAt(message) ?? Infinity) <= Date.parse(now)

const nextDeadline = (thread: Thread) => earliest([resumeAt(thread), ...thread.scheduled.map(deliveryAt)])

const bySendAt = (messages: ReadonlyArray<ScheduledMessage>) =>
  messages.toSorted((a, b) => Date.parse(a.sendAt) - Date.parse(b.sendAt))

interface ScheduleInput {
  readonly threadId: string
  readonly text: string
  readonly attachments: ReadonlyArray<Attachment>
  readonly workspace?: WorkspaceChoice | undefined
  readonly sendAt: string
}

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
      options?: QueueOptions,
    ) => Effect.Effect<void, SendError>
    readonly unqueue: (
      threadId: string,
      id: string,
    ) => Effect.Effect<QueuedMessage | null, PersistenceError | NotFoundError | ThreadStartedError>
    readonly schedule: (input: ScheduleInput) => Effect.Effect<void, PersistenceError | NotFoundError>
    readonly reschedule: (
      threadId: string,
      id: string,
      sendAt: string,
    ) => Effect.Effect<void, PersistenceError | NotFoundError>
    readonly unschedule: (
      threadId: string,
      id: string,
    ) => Effect.Effect<ScheduledMessage | null, PersistenceError | NotFoundError>
    readonly sendDueSchedules: Effect.Effect<void, PersistenceError>
    readonly steerWhen: (input: {
      readonly threadId: string
      readonly text: string
      readonly attachments: ReadonlyArray<Attachment>
      readonly messageId?: string | undefined
      readonly when: Effect.Effect<boolean, PersistenceError>
    }) => Effect.Effect<boolean, SendError>
    readonly interrupt: (threadId: string) => Effect.Effect<void>
    readonly stop: (threadId: string) => Effect.Effect<void>
    readonly isBusy: (threadId: string) => Effect.Effect<boolean>
    readonly release: <A, E>(threadId: string, whileIdle: Effect.Effect<A, E>) => Effect.Effect<Option.Option<A>, E>
    readonly warm: (threadId: string) => Effect.Effect<void>
    readonly resume: (threadId: string) => Effect.Effect<void, SendError>
    readonly resumeAtReset: (
      threadId: string,
      enabled: boolean,
    ) => Effect.Effect<Thread, AgentError | PersistenceError | NotFoundError | ThreadStartedError>
    readonly switchAccount: (
      threadId: string,
      accountId: string | null,
      options: { readonly resend: boolean },
    ) => Effect.Effect<Thread, SendError>
    readonly removeAccount: (accountId: string) => Effect.Effect<void, SendError | AccountInUseError>
    readonly switchAgent: (input: UpdateThread & { readonly provider: ProviderId }) => Effect.Effect<Thread, SendError>
    readonly setAccessMode: (threadId: string, accessMode: AccessMode) => Effect.Effect<void, AgentError>
    readonly respondApproval: (
      requestId: string,
      decision: ApprovalDecision,
      note?: string,
    ) => Effect.Effect<void, PersistenceError | NotFoundError>
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
    readonly toolOutput: (call: ToolCallRef) => Effect.Effect<unknown, PersistenceError | NotFoundError>
    readonly listModels: (provider: ProviderId) => Effect.Effect<ReadonlyArray<ModelInfo>, AgentError>
    readonly limits: Effect.Effect<ReadonlyArray<AccountLimits>, PersistenceError>
    readonly usage: (
      threadId: string,
    ) => Effect.Effect<ThreadUsage | null, AgentError | PersistenceError | NotFoundError>
    readonly contextBreakdown: (
      threadId: string,
    ) => Effect.Effect<ContextBreakdown | null, AgentError | PersistenceError | NotFoundError>
    readonly subagents: (threadId: string) => Effect.Effect<ReadonlyArray<Subagent>>
    readonly runAgent: (
      threadId: string,
      request: AgentRequest,
    ) => Effect.Effect<string, AgentError | PersistenceError | NotFoundError | FolderMissingError>
    readonly waitForAgent: (
      threadId: string,
      agentId: string,
    ) => Effect.Effect<string, AgentError | PersistenceError | NotFoundError>
    readonly stopSubagent: (
      threadId: string,
      subagentId: string,
    ) => Effect.Effect<void, AgentError | PersistenceError | NotFoundError>
    readonly backgroundTasks: (threadId: string) => Effect.Effect<ReadonlyArray<BackgroundTask>>
    readonly stopBackgroundTask: (
      threadId: string,
      taskId: string,
    ) => Effect.Effect<void, AgentError | PersistenceError | NotFoundError>
    readonly moveCommandToBackground: (
      threadId: string,
      callId: string,
    ) => Effect.Effect<boolean, AgentError | PersistenceError | NotFoundError>
    readonly listCommands: (
      threadId: string,
    ) => Effect.Effect<ReadonlyArray<AgentCommand>, AgentError | PersistenceError | NotFoundError | FolderMissingError>
    readonly listProjectCommands: (
      projectId: string,
      provider: ProviderId,
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

const userMessage = (
  threadId: string,
  text: string,
  attachments: ReadonlyArray<Attachment>,
  now: string,
  id: string = randomUUID(),
): Message => ({
  id,
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

const savedImage = (threadId: string, attachments: typeof Attachments.Service, record: Record<string, unknown>) => {
  const source = Predicate.isObject(record["source"]) ? (record["source"] as Record<string, unknown>) : record
  const mimeType = source["mimeType"] ?? source["media_type"]
  const data = source["data"]
  if (typeof mimeType !== "string" || typeof data !== "string") return Effect.succeed({ type: "image", mimeType })
  const name = `image${extensionForMime(mimeType)}`
  return attachments.stage(threadId, { dataUrl: `data:${mimeType};base64,${data}`, name }).pipe(
    Effect.map((attachment) => ({ type: "image", mimeType, attachment })),
    Effect.orElseSucceed(() => ({ type: "image", mimeType })),
  )
}

const withImagesSaved = (
  threadId: string,
  attachments: typeof Attachments.Service,
  value: unknown,
): Effect.Effect<unknown> => {
  if (Array.isArray(value)) return Effect.forEach(value, (item) => withImagesSaved(threadId, attachments, item))
  if (!Predicate.isObject(value)) return Effect.succeed(value)
  const record = value as Record<string, unknown>
  if (record["type"] === "image") return savedImage(threadId, attachments, record)
  return Effect.forEach(Object.entries(record), ([key, nested]) =>
    Effect.map(withImagesSaved(threadId, attachments, nested), (saved) => [key, saved] as const),
  ).pipe(Effect.map((entries) => Object.fromEntries(entries)))
}

const replaceLast = (messages: ReadonlyArray<Message>, message: Message) => [...messages.slice(0, -1), message]

const make = Effect.gen(function* () {
  const scope = yield* Effect.scope
  const threads = yield* Threads
  const worktrees = yield* Worktrees
  const scratch = yield* Scratch
  const attachments = yield* Attachments
  const git = yield* Git
  const pullRequests = yield* PullRequests
  const messages = yield* Messages
  const sql = yield* SqlClient.SqlClient
  const push = yield* Events
  const mcp = yield* McpCredentials
  const settings = yield* Settings
  const naming = yield* ThreadNaming
  const accounts = yield* AgentAccounts
  const projects = yield* Projects
  const activeWorkspace = yield* makeActiveWorkspace

  const providers: Record<ProviderId, AgentProvider> = {
    claude: yield* ClaudeProvider,
    codex: yield* CodexProvider,
    muse: yield* MuseProvider,
    opencode: yield* OpencodeProvider,
    magpie: yield* MagpieProvider,
  }

  const listedModels = (provider: AgentProvider) =>
    provider.listModels.pipe(
      Effect.timeout(Duration.seconds(3)),
      Effect.orElseSucceed(() => null),
    )

  const subagentInstructions = (experimental: ExperimentalSettings, environment: AgentEnvironment) =>
    Effect.gen(function* () {
      const settingsValue = yield* settings.get
      const enabled = enabledProviders(settingsValue)
      const listed = yield* Effect.all(
        Record.map(providers, (provider, id) => (enabled.includes(id) ? listedModels(provider) : Effect.succeed(null))),
        { concurrency: "unbounded" },
      )
      return agentInstructions(experimental, environment, subagentChoices(listed, settingsValue.modelPresets, enabled))
    })

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
  const deliveries = yield* FiberMap.make<string>()
  const busyThreads = new Set<string>()
  const pendingSends = new Map<string, Deferred.Deferred<void>>()
  const pendingScheduledSends = new Map<string, Deferred.Deferred<void>>()
  const activeTurns = new Map<string, ReturnType<typeof makeTurn>>()
  const approvals = new Map<string, ApprovalRequest>()
  const questions = new Map<string, QuestionRequest>()
  const secretRequests = new Map<
    string,
    { readonly request: SecretRequest; readonly answer: Deferred.Deferred<Option.Option<string>, AgentError> }
  >()
  const threadLocks = new Map<string, Semaphore.Semaphore>()
  const subagents = new Map<string, Map<string, Subagent>>()
  const agentRuns = new Map<
    string,
    {
      readonly threadId: string
      readonly stop: Effect.Effect<void>
      readonly reply: Deferred.Deferred<string, AgentError | PersistenceError | NotFoundError>
    }
  >()
  const backgroundTasks = new Map<string, ReadonlyArray<BackgroundTask>>()
  const transcriptSeqs = new Map<string, number>()

  yield* messages.closeInterrupted
  yield* threads.resetInterrupted

  const inTransaction = <A, E>(effect: Effect.Effect<A, E>) =>
    sql
      .withTransaction(effect)
      .pipe(Effect.catchTag("SqlError", (error) => Effect.fail(persistence("agentRunner.transaction")(error))))

  const updateThread = (input: Parameters<typeof threads.update>[0]) =>
    threads.update(input).pipe(Effect.tap((thread) => push.publish({ type: "thread.updated", thread })))

  const nextQueued = (threadId: string) =>
    Effect.gen(function* () {
      const { queue } = yield* threads.get(threadId)
      const unsent = yield* Effect.filter(queue, (queued) => Effect.map(messages.has(queued.id), (sent) => !sent))
      if (unsent.length < queue.length) yield* updateThread({ id: threadId, queue: unsent })
      return unsent[0]
    })

  const isQueued = (threadId: string, id: string) =>
    threads.get(threadId).pipe(
      Effect.map(({ queue }) => queue.some((queued) => queued.id === id)),
      Effect.catchTag("NotFoundError", () => Effect.succeed(false)),
    )

  const removeScheduled = (threadId: string, id: string) =>
    Effect.gen(function* () {
      const thread = yield* threads.get(threadId)
      if (!thread.scheduled.some((message) => message.id === id)) return
      yield* updateThread({ id: threadId, scheduled: thread.scheduled.filter((message) => message.id !== id) })
    })

  const waitsOnUser = (threadId: string) =>
    [...approvals.values(), ...questions.values(), ...[...secretRequests.values()].map(({ request }) => request)].some(
      (request) => request.threadId === threadId,
    )

  const isBusy = (threadId: string) =>
    busyThreads.has(threadId) || activeTurns.has(threadId) || pendingSends.has(threadId)

  const exclusive =
    (threadId: string) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>) => {
      let lock = threadLocks.get(threadId)
      if (lock === undefined) threadLocks.set(threadId, (lock = Semaphore.makeUnsafe(1)))
      return Semaphore.withPermit(lock, effect)
    }

  const respondApproval = (requestId: string, decision: ApprovalDecision, note?: string) =>
    Effect.suspend(() => {
      const request = approvals.get(requestId)
      if (request === undefined) return Effect.void
      const text = note?.trim() || undefined
      return Effect.gen(function* () {
        const delivered = yield* providers[request.provider].respondApproval(requestId, decision, text)
        if (text === undefined || delivered) return
        const steers = activeTurns.get(request.threadId)?.provider.steer !== undefined
        const { queue } = yield* threads.get(request.threadId)
        yield* updateThread({
          id: request.threadId,
          queue: [{ id: randomUUID(), text, attachments: [], ...(steers && { steer: true as const }) }, ...queue],
        })
      }).pipe(exclusive(request.threadId))
    })

  const listSubagents = (threadId: string) => [...(subagents.get(threadId)?.values() ?? [])].toReversed()

  const updateSubagent = (threadId: string, subagent: Subagent) => {
    let byId = subagents.get(threadId)
    if (byId === undefined) subagents.set(threadId, (byId = new Map()))
    byId.set(subagent.id, subagent)
    return push.publish({ type: "thread.subagents", threadId, subagents: listSubagents(threadId) })
  }

  const markSubagentsStopped = (threadId: string) =>
    Effect.gen(function* () {
      const byId = subagents.get(threadId)
      const running = [...(byId?.values() ?? [])].filter((subagent) => subagent.status === "running")
      if (byId === undefined || running.length === 0) return
      const endedAt = yield* nowIso
      for (const subagent of running) byId.set(subagent.id, { ...subagent, status: "stopped", endedAt })
      yield* push.publish({ type: "thread.subagents", threadId, subagents: listSubagents(threadId) })
    })

  const closeProviderSession = (thread: Thread) =>
    Effect.gen(function* () {
      const close = providers[thread.provider].closeSession
      if (close !== undefined) yield* close(thread.id, yield* accounts.home(thread.accountId))
      yield* markSubagentsStopped(thread.id)
    })

  const stopAgentRuns = (threadId: string) =>
    Effect.forEach(
      [...agentRuns].filter(([, run]) => run.threadId === threadId),
      ([id, run]) =>
        Effect.andThen(
          Effect.sync(() => agentRuns.delete(id)),
          Effect.flatMap(Deferred.isDone(run.reply), (done) => (done ? Effect.void : run.stop)),
        ),
      { discard: true },
    )

  const waitForAgent = (threadId: string, agentId: string) =>
    Effect.suspend(() => {
      const run = agentRuns.get(agentId)
      if (run?.threadId !== threadId) {
        return Effect.fail(
          new AgentError({ provider: "hinacode", message: `No agent ${agentId} runs in this thread's turn.` }),
        )
      }
      return Deferred.await(run.reply).pipe(
        Effect.timeoutOption(RUN_AGENT_WAIT),
        Effect.map(
          Option.getOrElse(
            () =>
              `The agent is still running. Call ${WAIT_AGENT_TOOL} with agentId "${agentId}" to keep waiting for its reply.`,
          ),
        ),
      )
    })

  const publishTranscript = (event: DistributiveOmit<TranscriptPush, "seq">, { whole = false } = {}) => {
    const threadId = transcriptThreadId(event)
    const seq = (transcriptSeqs.get(threadId) ?? 0) + 1
    transcriptSeqs.set(threadId, seq)
    const numbered = { ...event, seq }
    return push.publish(whole ? numbered : previewPush(numbered))
  }

  const gitOutput = (cwd: string, args: ReadonlyArray<string>) =>
    git.run(cwd, args).pipe(
      Effect.map((out) => out.trim()),
      Effect.option,
    )

  const readEnvironment = (thread: Thread, { cwd, rootPath }: ActiveWorkspace) =>
    Effect.all(
      [
        gitOutput(cwd, ["branch", "--show-current"]),
        gitOutput(cwd, ["remote", "get-url", "origin"]),
        scratch.ensure(thread),
        scratch.ensureTmp(thread.id),
      ],
      { concurrency: "unbounded" },
    ).pipe(
      Effect.map(([branch, remote, scratchDirectory, tmpDirectory]): AgentEnvironment => ({
        gitRepository: Option.isSome(branch),
        branch: Option.getOrNull(branch) || null,
        cwd,
        rootPath,
        remote: Option.getOrNull(remote) || null,
        platform: process.platform,
        scratchDirectory,
        tmpDirectory,
      })),
    )

  const sessionInput = (
    thread: Thread,
    provider: AgentProvider,
    cwd: string,
    home: AccountHome | null,
    environment: AgentEnvironment,
  ) =>
    Effect.gen(function* () {
      const [mcpServer, { experimental, autoCompactTokens }] = yield* Effect.all([
        mcp.connectionFor(thread.id),
        settings.get,
      ])
      const input: SessionInput = {
        threadId: thread.id,
        cwd,
        tmpDirectory: environment.tmpDirectory,
        model: thread.model,
        effort: thread.effort,
        fastMode: thread.fastMode,
        autoCompactTokens: autoCompactTokens[provider.id],
        accessMode: thread.accessMode,
        resumeSessionId: thread.providerSessionId ?? thread.forkedFrom?.sessionId ?? null,
        forkAt: thread.providerSessionId === null ? (thread.forkedFrom?.checkpoint ?? null) : null,
        home,
        mcpServer,
        instructions: yield* subagentInstructions(experimental, environment),
      }
      return input
    })

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
    let persistedBytes = 0
    const dirty = new Map<string, Message>()
    const subagentCalls = new Set<string>()

    const persist = Effect.suspend(() => {
      const changed = turnMessages.flatMap((message) => {
        const previous = dirty.get(message.id)
        return previous === undefined ? [] : [{ message, previous }]
      })
      dirty.clear()
      persistedAt = Date.now()
      const unsaved = new Map(changed.map(({ message, previous }) => [message.id, previous]))
      return Effect.forEach(changed, ({ message, previous }) =>
        messages.update(message, previous).pipe(Effect.tap(() => Effect.sync(() => unsaved.delete(message.id)))),
      ).pipe(
        Effect.tapError(() => Effect.sync(() => unsaved.forEach((previous, id) => dirty.set(id, previous)))),
        Effect.map((writes) => {
          persistedBytes = writes.reduce((total, { bytes }) => total + bytes, 0)
        }),
      )
    })

    const setTurnMessages = (next: ReadonlyArray<Message>) => {
      next.forEach((message, index) => {
        const saved = turnMessages[index]
        if (saved !== undefined && message !== saved && !dirty.has(message.id)) dirty.set(message.id, saved)
      })
      turnMessages = next
    }

    const apply = (event: AgentEvent) =>
      Effect.gen(function* () {
        if (event.type === "tool_call_started" && spawnsSubagent(event)) subagentCalls.add(event.callId)
        const whole = event.type === "tool_call_finished" && subagentCalls.has(event.callId)
        yield* publishTranscript({ type: "thread.event", threadId: thread.id, event }, { whole })
        setTurnMessages(foldTranscript(turnMessages, event, yield* nowIso))

        if (event.type === "approval_requested") approvals.set(event.request.id, event.request)
        if (event.type === "approval_resolved") approvals.delete(event.requestId)
        if (event.type === "question_requested") questions.set(event.request.id, event.request)
        if (event.type === "question_resolved") questions.delete(event.requestId)
        if (event.type === "session_bound" && event.providerSessionId !== thread.providerSessionId) {
          yield* updateThread({ id: thread.id, providerSessionId: event.providerSessionId })
        }
        if (event.type === "turn_failed" && event.sessionLost)
          yield* updateThread({ id: thread.id, providerSessionId: null })
        if (event.type === "turn_completed" || event.type === "turn_failed") completed = event.type === "turn_completed"
        const resolvedStatus = statusAfter(event)
        const nextStatus = resolvedStatus === "running" && waitsOnUser(thread.id) ? "awaiting_approval" : resolvedStatus
        if (nextStatus !== undefined && nextStatus !== status) {
          status = nextStatus
          yield* updateThread({
            id: thread.id,
            status,
            ...(event.type === "turn_limited" ? { usageLimit: event.limit } : {}),
          })
        }
        if (
          event.type === "approval_resolved" ||
          event.type === "question_resolved" ||
          event.type === "secret_resolved"
        ) {
          yield* steerHeld
        }
        const interval = Math.max(PERSIST_INTERVAL_MS, (persistedBytes / PERSIST_BYTES_PER_SECOND) * 1000)
        if (dirty.size > 0 && Date.now() - persistedAt >= interval) yield* persist
      })

    const deltas = makeDeltaCoalescer({ apply, exclusive: exclusive(thread.id), scope })

    const handle = (received: AgentEvent) =>
      Effect.gen(function* () {
        const event: AgentEvent =
          received.type === "tool_call_finished"
            ? { ...received, output: yield* withImagesSaved(thread.id, attachments, received.output) }
            : received.type === "turn_completed" && received.forkPoint !== undefined
              ? {
                  ...received,
                  forkPoint: { ...received.forkPoint, owner: { provider: provider.id, accountId: thread.accountId } },
                }
              : received.type === "turn_failed" && (yield* Deferred.isDone(stop))
                ? { ...received, stopped: true }
                : received
        if (event.type === "subagent_updated") return yield* updateSubagent(thread.id, event.subagent)
        if (event.type === "approval_requested" && (yield* threads.get(thread.id)).accessMode === "full") {
          return yield* Effect.asVoid(providers[event.request.provider].respondApproval(event.request.id, "allow"))
        }
        yield* deltas.offer(event)
      }).pipe(exclusive(thread.id))

    const steerHeld: Effect.Effect<void> = Effect.gen(function* () {
      if (provider.steer === undefined || waitsOnUser(thread.id)) return
      const held = (yield* threads.get(thread.id)).queue.filter((message) => message.steer)
      for (const message of held) {
        const dequeue = Effect.gen(function* () {
          const { queue } = yield* threads.get(thread.id)
          yield* updateThread({ id: thread.id, queue: queue.filter((queued) => queued.id !== message.id) })
        })
        yield* steerTurn(message.text, message.attachments, "next", message.id, dequeue)
      }
    }).pipe(Effect.catch((error) => Effect.logWarning("held message did not steer", error)))

    const steer = (
      text: string,
      attachments: ReadonlyArray<Attachment>,
      when: Effect.Effect<boolean, PersistenceError>,
      messageId: string,
    ) =>
      Effect.gen(function* () {
        if (finishing) return "finished" as const
        if (provider.steer === undefined || !(yield* when)) return false
        if (!waitsOnUser(thread.id)) {
          yield* steerTurn(text, attachments, "now", messageId)
          return true
        }
        const { queue } = yield* threads.get(thread.id)
        yield* updateThread({ id: thread.id, queue: [...queue, { id: messageId, text, attachments, steer: true }] })
        return true
      }).pipe(exclusive(thread.id))

    const steerTurn = (
      text: string,
      attachments: ReadonlyArray<Attachment>,
      priority: SteerPriority,
      messageId: string,
      alsoOnRecord: Effect.Effect<void, PersistenceError | NotFoundError> = Effect.void,
    ) =>
      Effect.gen(function* () {
        if (provider.steer === undefined) return
        yield* deltas.flush
        yield* provider.steer(thread.id, expandDocumentCommand(expandArtifactSkill(text)), attachments, priority)
        const now = yield* nowIso
        yield* inTransaction(
          insertMessage(userMessage(thread.id, text, attachments, now, messageId)).pipe(Effect.andThen(alsoOnRecord)),
        )
        const current = turnMessages.at(-1)!
        const closed: Message = { ...current, completedAt: now }
        setTurnMessages(replaceLast(turnMessages, closed))
        yield* persist
        yield* publishTranscript({ type: "message.updated", message: closed })

        const next = openAssistantMessage(thread.id, now)
        yield* insertMessage(next)
        turnMessages = [...turnMessages, next]
      })

    let next: QueuedMessage | undefined
    let finishing = false
    let shutDown = false
    const withdraw = (event: AgentEvent) => publishTranscript({ type: "thread.event", threadId: thread.id, event })
    const finish = Effect.gen(function* () {
      finishing = true
      yield* deltas.flush
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
      yield* stopAgentRuns(thread.id)
      if (provider.subagentChanges === undefined) yield* markSubagentsStopped(thread.id)
      const last = turnMessages.at(-1)!
      const closed: Message = last.completedAt === null ? { ...last, completedAt: yield* nowIso } : last
      setTurnMessages(replaceLast(turnMessages, closed))
      yield* persist
      if (closed !== last) yield* publishTranscript({ type: "message.updated", message: closed })
      const stopped = yield* Deferred.isDone(stop)
      if (isThreadBusy(status))
        yield* updateThread({ id: thread.id, status: shutDown && !stopped ? "interrupted" : "idle" })
      if (!completed || stopped) return
      next = yield* nextQueued(thread.id)
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
        Effect.catchTag("AgentError", ({ message, loginCommand }) =>
          handle({
            type: "turn_failed",
            message,
            ...(loginCommand !== undefined && { signedOut: true, loginCommand }),
          }),
        ),
        Effect.catch((error) => Effect.logError("turn bookkeeping failed", error)),
        Effect.onInterrupt(() =>
          Effect.sync(() => {
            shutDown = true
          }),
        ),
        Effect.ensuring(finish),
      )

    const run = (prompt: string, attachments: ReadonlyArray<Attachment>, environment: AgentEnvironment) =>
      follow(
        Stream.unwrap(
          Effect.gen(function* () {
            const input = yield* sessionInput(thread, provider, cwd, home, environment)
            if (yield* Deferred.isDone(stop)) {
              return Stream.succeed(interruptedTurn)
            }
            return provider.runTurn({ ...input, prompt, attachments })
          }),
        ),
      )

    const interrupt = Effect.gen(function* () {
      yield* Deferred.succeed(stop, undefined)
      yield* provider.interrupt(thread.id)
    })

    return {
      provider,
      steer,
      run,
      follow,
      handle,
      interrupt,
      messages: () => turnMessages,
      isFinishing: () => finishing,
    }
  }

  const subagentModel = (request: AgentRequest, threadModel: string | null) =>
    Effect.gen(function* () {
      const { modelPresets, providerEnabled } = yield* settings.get
      if (!providerEnabled[request.provider]) {
        return yield* new AgentError({
          provider: request.provider,
          message: `${providerInfo[request.provider].name} is disabled in Settings.`,
        })
      }
      if (providerInfo[request.provider].subagentModels === "picked") {
        const listed = yield* providers[request.provider].listModels.pipe(Effect.orElseSucceed(() => null))
        const resolved = pickedSubagentModel({
          agent: providerInfo[request.provider].name,
          requested: request.model,
          threadModel,
          picked: modelPresets[request.provider],
          listed: (listed ?? []).map(({ id }) => id),
        })
        if (resolved.kind === "refused") {
          return yield* new AgentError({ provider: request.provider, message: resolved.message })
        }
        return resolved.model
      }
      const model = request.model ?? threadModel ?? (yield* providers[request.provider].listModels)[0]?.id
      if (model === undefined) {
        return yield* new AgentError({ provider: request.provider, message: "This agent lists no models." })
      }
      return model
    })

  const runAgent = (threadId: string, request: AgentRequest) =>
    Effect.gen(function* () {
      const turn = activeTurns.get(threadId)
      if (turn === undefined) {
        return yield* new AgentError({ provider: "hinacode", message: "Agents run only during this thread's turn." })
      }
      const thread = yield* threads.get(threadId)
      const provider = providers[request.provider]
      const sameProvider = request.provider === thread.provider
      const model = yield* subagentModel(request, sameProvider ? thread.model : null)
      const effort =
        request.effort ??
        (yield* provider.listModels.pipe(Effect.orElseSucceed(() => []))).find((listed) => listed.id === model)
          ?.defaultEffort
      const workspace = yield* activeWorkspace(threadId)
      const [home, environment, mcpServer, { experimental, autoCompactTokens }, startedAt] = yield* Effect.all([
        accounts.home(sameProvider ? thread.accountId : null),
        readEnvironment(thread, workspace),
        mcp.connectionFor(threadId),
        settings.get,
        nowIso,
      ])
      const instructions = yield* subagentInstructions(experimental, environment)

      const id = randomUUID()
      const sessionId = `${threadId}:agent:${id}`
      const callId = spawningCallId(turn.messages(), request.prompt) ?? sessionId
      let subagent: Subagent = {
        id,
        provider: request.provider,
        model,
        ...(effort && { effort }),
        label: request.description,
        callId,
        status: "running",
        summary: null,
        lastTool: null,
        toolUses: 0,
        tokens: null,
        startedAt,
        endedAt: null,
      }
      const update = (patch: Partial<Subagent>) => updateSubagent(threadId, (subagent = { ...subagent, ...patch }))

      let reply = ""
      let failure: string | null = null
      let stopped = false
      if (activeTurns.get(threadId) !== turn || turn.isFinishing()) {
        return yield* new AgentError({
          provider: "hinacode",
          message: "This thread's turn ended before the agent started.",
        })
      }
      const finalReply = Deferred.makeUnsafe<string, AgentError | PersistenceError | NotFoundError>()
      agentRuns.set(id, {
        threadId,
        stop: Effect.suspend(() => {
          stopped = true
          return provider.interrupt(sessionId)
        }),
        reply: finalReply,
      })
      yield* update({})

      const forward = (event: AgentEvent) => {
        switch (event.type) {
          case "text_delta":
            reply += event.text
            return Effect.void
          case "tool_call_started":
            reply = ""
            return Effect.andThen(
              turn.handle({ ...event, parentCallId: event.parentCallId ?? callId }),
              update({ toolUses: (subagent.toolUses ?? 0) + 1, lastTool: event.name }),
            )
          case "approval_requested":
            return turn.handle({ ...event, request: { ...event.request, threadId } })
          case "question_requested":
            return turn.handle({ ...event, request: { ...event.request, threadId } })
          case "tool_call_finished":
          case "file_changed":
          case "approval_resolved":
          case "question_resolved":
            return turn.handle(event)
          case "turn_completed":
            return event.usage === undefined
              ? Effect.void
              : update({ tokens: event.usage.inputTokens + event.usage.outputTokens })
          case "turn_failed":
            failure = event.message
            return Effect.void
          case "turn_limited":
            failure = "This agent hit its usage limit."
            return Effect.void
          default:
            return Effect.void
        }
      }

      const execution = provider
        .runTurn({
          threadId: sessionId,
          prompt: request.prompt,
          attachments: [],
          cwd: workspace.cwd,
          tmpDirectory: environment.tmpDirectory,
          model,
          effort: request.effort ?? null,
          fastMode: false,
          autoCompactTokens: autoCompactTokens[provider.id],
          accessMode: thread.accessMode,
          resumeSessionId: null,
          forkAt: null,
          home,
          mcpServer,
          instructions,
        })
        .pipe(
          Stream.runForEach(forward),
          Effect.catchTag("AgentError", (error) => Effect.sync(() => (failure = error.message))),
          Effect.onInterrupt(() =>
            Effect.sync(() => (stopped = true)).pipe(Effect.andThen(provider.interrupt(sessionId))),
          ),
          Effect.ensuring(
            Effect.gen(function* () {
              const status = stopped ? "stopped" : failure === null ? "completed" : "failed"
              yield* update({ status, summary: failure ?? (reply.trim() || null), endedAt: yield* nowIso })
              yield* provider.closeSession?.(sessionId, home).pipe(Effect.ignore) ?? Effect.void
            }),
          ),
          Effect.andThen(
            Effect.suspend(() => {
              if (stopped) {
                return Effect.fail(
                  new AgentError({ provider: request.provider, message: "The user stopped this agent." }),
                )
              }
              if (failure !== null) return Effect.fail(new AgentError({ provider: request.provider, message: failure }))
              return Effect.succeed(reply.trim())
            }),
          ),
        )
      yield* Effect.forkIn(
        Effect.flatMap(Effect.exit(execution), (exit) => Deferred.done(finalReply, exit)),
        scope,
      )
      return yield* waitForAgent(threadId, id)
    })

  const liveMessages = (threadId: string) =>
    messages.list(threadId).pipe(
      Effect.map((persisted) => {
        const live = new Map(
          activeTurns
            .get(threadId)
            ?.messages()
            .map((message) => [message.id, message]),
        )
        return persisted.map((message) => live.get(message.id) ?? message)
      }),
    )

  const promptForSession = (thread: Thread, prompt: string) =>
    Effect.gen(function* () {
      if (thread.providerSessionId !== null) return prompt
      if (thread.sideOf !== null) {
        const unseen = unseenSince(yield* liveMessages(thread.sideOf), thread.forkedFrom)
        const history = yield* messages.list(thread.id)
        return sidechatPrompt({ history, unseen, prompt })
      }
      if (thread.forkedFrom !== null) return prompt
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
        if (thread.status === "draft") {
          thread = yield* threads.promoteDraft(threadId)
          yield* push.publish({ type: "thread.updated", thread })
        }
        const first = !(yield* threads.started(threadId))
        if (first && thread.sideOf !== null) {
          const parent = yield* threads.get(thread.sideOf)
          const forkPoint = latestForkPoint(parent.provider, yield* liveMessages(parent.id))
          thread = yield* threads.rebaseSidechat(threadId, parent, forkPoint)
          yield* push.publish({ type: "thread.updated", thread })
        }
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
            const provider = providers[thread.provider]
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
            const agentPrompt = yield* promptForSession(thread, expandDocumentCommand(expandArtifactSkill(prompt)))
            const now = yield* nowIso
            const user = userMessage(threadId, prompt, attachments, now, options.messageId ?? options.scheduledId)
            const assistant = openAssistantMessage(threadId, now)
            const running = yield* inTransaction(
              Effect.gen(function* () {
                yield* messages.insert(user)
                if (options.scheduledId !== undefined) yield* removeScheduled(threadId, options.scheduledId)
                yield* messages.insert(assistant)
                const { queue } = yield* threads.get(threadId)
                return yield* threads.update({
                  id: threadId,
                  status: "running",
                  queue: queue.filter((queued) => queued.id !== user.id),
                })
              }),
            )
            yield* publishTranscript({ type: "message.created", message: user })
            yield* publishTranscript({ type: "message.created", message: assistant })
            yield* push.publish({ type: "thread.updated", thread: running })
            return { thread, environment, agentPrompt, turn: makeTurn(thread, provider, cwd, home, assistant, stop) }
          }),
        )
        if (admitted === null) return false
        const { thread: currentThread, environment, agentPrompt, turn } = admitted
        activeTurns.set(threadId, turn)
        pendingSends.delete(threadId)
        if (options.scheduledId !== undefined) pendingScheduledSends.delete(options.scheduledId)
        yield* FiberMap.run(turns, threadId, turn.run(agentPrompt, attachments, environment))
        if (
          pending.first &&
          currentThread.createdBy === "user" &&
          currentThread.sideOf === null &&
          prompt.trim() !== ""
        )
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
      if (options.scheduledId !== undefined) pendingScheduledSends.set(options.scheduledId, stop)
      const accepted = yield* activeWorkspace(threadId).pipe(
        Effect.flatMap(({ worktreeId }) => startTurn(threadId, prompt, attachments, options, stop, when, worktreeId)),
        Effect.onError(() => Effect.sync(() => busyThreads.delete(threadId))),
        Effect.ensuring(
          Effect.sync(() => {
            if (pendingSends.get(threadId) === stop) pendingSends.delete(threadId)
            if (options.scheduledId !== undefined) pendingScheduledSends.delete(options.scheduledId)
          }),
        ),
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

  const queue = (
    threadId: string,
    text: string,
    attachments: ReadonlyArray<Attachment>,
    { messageId = randomUUID(), when = Effect.succeed(true) }: QueueOptions = {},
  ) =>
    Effect.gen(function* () {
      const queued = yield* Effect.gen(function* () {
        if (!busyThreads.has(threadId)) return "send" as const
        if (!(yield* when)) return "declined" as const
        const thread = yield* threads.get(threadId)
        yield* updateThread({ id: threadId, queue: [...thread.queue, { id: messageId, text, attachments }] })
        return "queued" as const
      }).pipe(exclusive(threadId))
      if (queued === "send") return yield* sendWhen(threadId, text, attachments, { messageId }, when)
      return queued === "queued"
    })

  const unqueue = (threadId: string, id: string) =>
    Effect.gen(function* () {
      const thread = yield* threads.get(threadId)
      const message = thread.queue.find((queued) => queued.id === id)
      if (message === undefined) return null
      yield* updateThread({ id: threadId, queue: thread.queue.filter((queued) => queued.id !== id) })
      return message
    }).pipe(exclusive(threadId))

  const startQueued = (threadId: string, message: QueuedMessage): Effect.Effect<void> =>
    startClaimed(
      threadId,
      message.text,
      message.attachments,
      { messageId: message.id },
      isQueued(threadId, message.id),
    ).pipe(
      Effect.catch((error) => Effect.logWarning("queued message did not start", error).pipe(Effect.as(false))),
      Effect.flatMap((started) => (started ? Effect.void : startNextQueued(threadId, message))),
    )

  const startNextQueued = (threadId: string, skipped: QueuedMessage) =>
    Effect.gen(function* () {
      if (busyThreads.has(threadId) || (yield* isQueued(threadId, skipped.id))) return undefined
      const next = yield* nextQueued(threadId)
      if (next !== undefined) busyThreads.add(threadId)
      return next
    }).pipe(
      exclusive(threadId),
      Effect.flatMap((next) => (next === undefined ? Effect.void : Effect.forkDetach(startQueued(threadId, next)))),
      Effect.catch((cause) => Effect.logError("failed to start the next queued message", cause)),
    )

  const steerWhen: typeof AgentRunner.Service.steerWhen = (input) =>
    Effect.suspend(() => {
      const { threadId, text, attachments, when, messageId = randomUUID() } = input
      const turn = activeTurns.get(threadId)
      if (turn === undefined) return sendWhen(threadId, text, attachments, { messageId }, when)
      if (turn.provider.steer !== undefined) {
        return Effect.flatMap(turn.steer(text, attachments, when, messageId), (steered) =>
          steered === "finished" ? steerWhen({ ...input, messageId }) : Effect.succeed(steered),
        )
      }
      return queue(threadId, text, attachments, { messageId, when })
    })

  const resume = (threadId: string) =>
    Effect.gen(function* () {
      const thread = yield* threads.get(threadId)
      if (thread.status !== "interrupted") {
        return yield* new AgentError({ provider: "hinacode", message: "This thread was not interrupted" })
      }
      yield* send(threadId, RESUME_PROMPT, [])
    })

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
      if (busyThreads.has(thread.id) || limit?.reset == null || !resumeIsDue(thread, now)) return
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

  const resumeDue = (list: ReadonlyArray<Thread>, now: string) =>
    Effect.gen(function* () {
      const due = list.filter((thread) => resumeIsDue(thread, now))
      for (const candidate of due) {
        yield* Effect.gen(function* () {
          const prompt = yield* consumeDueResume(candidate.id, now)
          if (prompt !== undefined) yield* resend(candidate.id, prompt)
        }).pipe(Effect.catch((error) => Effect.logWarning("automatic resume failed", error)))
      }
    })

  const schedule = ({ threadId, text, attachments, workspace, sendAt }: ScheduleInput) =>
    Effect.gen(function* () {
      const thread = yield* threads.get(threadId)
      const message: ScheduledMessage = { id: randomUUID(), text, attachments, sendAt, ...(workspace && { workspace }) }
      yield* updateThread({ id: threadId, scheduled: bySendAt([...thread.scheduled, message]) })
    }).pipe(exclusive(threadId))

  const sending = new Set<string>()

  const wasSent = (threadId: string, id: string) =>
    messages.list(threadId).pipe(Effect.map((stored) => stored.some((message) => message.id === id)))

  const stopDelivery = (id: string) =>
    Effect.gen(function* () {
      while (sending.has(id)) {
        const pending = pendingScheduledSends.get(id)
        if (pending !== undefined) yield* Deferred.succeed(pending, undefined)
        yield* Effect.sleep("20 millis")
      }
    })

  const reschedule = (threadId: string, id: string, sendAt: string) =>
    stopDelivery(id).pipe(
      Effect.andThen(
        Effect.gen(function* () {
          const thread = yield* threads.get(threadId)
          if (!thread.scheduled.some((message) => message.id === id)) return
          if (yield* wasSent(threadId, id)) return yield* removeScheduled(threadId, id)
          const moved = thread.scheduled.map((message) => {
            if (message.id !== id) return message
            const { failure, ...retried } = message
            return failure === undefined ? { ...message, sendAt } : { ...retried, sendAt }
          })
          yield* updateThread({ id: threadId, scheduled: bySendAt(moved) })
        }).pipe(exclusive(threadId)),
      ),
    )

  const unschedule = (threadId: string, id: string) =>
    stopDelivery(id).pipe(
      Effect.andThen(
        Effect.gen(function* () {
          const message = (yield* threads.get(threadId)).scheduled.find((scheduled) => scheduled.id === id)
          if (message === undefined) return null
          const sent = yield* wasSent(threadId, id)
          yield* removeScheduled(threadId, id)
          return sent ? null : message
        }).pipe(exclusive(threadId)),
      ),
    )

  const claimDue = (threadId: string, now: string) =>
    Effect.gen(function* () {
      const message = (yield* threads.get(threadId)).scheduled.find((scheduled) => isDue(scheduled, now))
      if (message === undefined) return undefined
      if (yield* wasSent(threadId, message.id)) {
        yield* removeScheduled(threadId, message.id)
        return undefined
      }
      sending.add(message.id)
      return message
    }).pipe(exclusive(threadId))

  const queueScheduled = (threadId: string, message: ScheduledMessage) =>
    Effect.gen(function* () {
      if (!busyThreads.has(threadId)) return false
      const thread = yield* threads.get(threadId)
      yield* updateThread({
        id: threadId,
        queue: [...thread.queue, { id: randomUUID(), text: message.text, attachments: message.attachments }],
        scheduled: thread.scheduled.filter((scheduled) => scheduled.id !== message.id),
      })
      return true
    }).pipe(exclusive(threadId))

  const markScheduledFailed = (threadId: string, id: string, failure: string) =>
    Effect.gen(function* () {
      const thread = yield* threads.get(threadId)
      if (!thread.scheduled.some((message) => message.id === id)) return
      const scheduled = thread.scheduled.map((message) => (message.id === id ? { ...message, failure } : message))
      yield* updateThread({ id: threadId, scheduled })
    }).pipe(exclusive(threadId))

  const deliverScheduled = (threadId: string, message: ScheduledMessage) =>
    Effect.gen(function* () {
      let thread = yield* threads.get(threadId)
      if (thread.status === "archived") {
        thread = yield* threads.unarchive(threadId)
        yield* push.publish({ type: "thread.updated", thread })
      }
      const fresh = thread.worktreeId === null && !(yield* threads.started(threadId))
      const workspace = fresh ? message.workspace : undefined
      if (workspace === undefined && (yield* queueScheduled(threadId, message))) return
      yield* send(threadId, message.text, message.attachments, { workspace, scheduledId: message.id })
    })

  const deliverDue = (threadId: string) =>
    Effect.gen(function* () {
      const message = yield* claimDue(threadId, yield* nowIso)
      if (message === undefined) return
      yield* deliverScheduled(threadId, message).pipe(
        Effect.catch((error) =>
          Effect.logWarning("scheduled message did not send", error).pipe(
            Effect.andThen(markScheduledFailed(threadId, message.id, error.message)),
          ),
        ),
        Effect.ensuring(Effect.sync(() => sending.delete(message.id))),
      )
    }).pipe(Effect.catch((error) => Effect.logWarning("could not deliver a scheduled message", error)))

  const sendDue = (list: ReadonlyArray<Thread>, now: string) =>
    Effect.forEach(
      list.filter((thread) => thread.scheduled.some((message) => isDue(message, now))),
      (thread) => FiberMap.run(deliveries, thread.id, deliverDue(thread.id), { onlyIfMissing: true }),
      { discard: true },
    )

  const sendDueSchedules = Effect.gen(function* () {
    yield* sendDue(yield* threads.list, yield* nowIso)
  })

  const runDue = Effect.gen(function* () {
    const list = yield* threads.list
    const now = yield* nowIso
    yield* resumeDue(list, now)
    yield* sendDue(list, now)
    return earliest(list.map(nextDeadline))
  }).pipe(
    Effect.catch((error) =>
      Effect.logWarning("deadline check failed", error).pipe(Effect.andThen(Clock.currentTimeMillis)),
    ),
  )

  const copySessionToAccount = (thread: Thread, accountId: string | null) =>
    Effect.gen(function* () {
      const sessionId = thread.providerSessionId ?? thread.forkedFrom?.sessionId ?? null
      if (sessionId === null) return
      const provider = providers[thread.provider]
      if (provider.copySession === undefined) return yield* new ThreadStartedError({ id: thread.id })
      yield* provider.copySession(sessionId, yield* accounts.home(thread.accountId), yield* accounts.home(accountId))
    })

  const moveToAccount = (thread: Thread, accountId: string | null) =>
    updateThread({
      id: thread.id,
      accountId,
      ...(thread.status === "limited" && { status: "idle" }),
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
        yield* copySessionToAccount(current, accountId)
        const thread = yield* moveToAccount(current, accountId)
        return { thread, prompt: options.resend ? yield* lastPrompt(threadId) : undefined }
      }).pipe(exclusive(threadId))
      if (switched.prompt !== undefined) yield* resend(threadId, switched.prompt)
      return switched.thread
    })

  const removeAccount: typeof AgentRunner.Service.removeAccount = (accountId) =>
    Effect.gen(function* () {
      const { provider } = yield* accounts.get(accountId)
      const onAccount = yield* threads.onAccount(accountId)
      const running = onAccount.filter((thread) => busyThreads.has(thread.id)).length
      if (running > 0) return yield* new AccountInUseError({ id: accountId, threads: running })
      const { defaultAccount } = yield* settings.get
      const successor = defaultAccount[provider] === accountId ? null : defaultAccount[provider]
      yield* Effect.forEach(onAccount, ({ id }) =>
        Effect.gen(function* () {
          const thread = yield* threads.get(id)
          if (thread.accountId !== accountId) return
          if (busyThreads.has(id)) return yield* new AccountInUseError({ id: accountId, threads: 1 })
          yield* copySessionToAccount(thread, successor).pipe(
            Effect.catchTag("AgentError", (error) =>
              Effect.logWarning("Moved a thread off a removed account without its transcript", error),
            ),
          )
          yield* moveToAccount(thread, successor)
        }).pipe(exclusive(id)),
      )
      yield* accounts.remove(accountId)
    })

  const switchAgent: typeof AgentRunner.Service.switchAgent = (input) =>
    Effect.gen(function* () {
      if (busyThreads.has(input.id)) {
        return yield* new AgentError({ provider: "hinacode", message: "Wait for the turn to end to switch agents" })
      }
      const current = yield* threads.get(input.id)
      if (input.provider === current.provider) return yield* threads.update(input)
      yield* closeProviderSession(current)
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

  const threadWrites = yield* threads.writes
  yield* runAtDeadlines(runDue, Stream.map(threadWrites, nextDeadline)).pipe(Effect.forkIn(scope))

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

  const canReportSubagent = (threadId: string, provider: ProviderId) =>
    threads.get(threadId).pipe(
      Effect.map((thread) => thread.provider === provider && (thread.status === "idle" || thread.status === "running")),
      Effect.catchTag("NotFoundError", () => Effect.succeed(false)),
    )

  const recordSubagentChange = (provider: ProviderId, { threadId, subagent }: SubagentChange) =>
    Effect.gen(function* () {
      const previous = subagents.get(threadId)?.get(subagent.id)
      yield* updateSubagent(threadId, subagent)
      const ended = subagent.status === "completed" || subagent.status === "failed"
      if (previous?.status !== "running" || !ended) return
      yield* steerWhen({
        threadId,
        text: subagentReport(subagent),
        attachments: [],
        when: canReportSubagent(threadId, provider),
      }).pipe(
        Effect.catchCause((cause) => Effect.logWarning("could not hand a sub-agent's reply to its thread", cause)),
        Effect.forkIn(scope),
      )
    })

  for (const provider of Object.values(providers)) {
    if (provider.subagentChanges === undefined) continue
    yield* Effect.forkIn(
      Stream.runForEach(provider.subagentChanges, (change) => recordSubagentChange(provider.id, change)),
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

  const stopSubagent: AgentRunner["Service"]["stopSubagent"] = (threadId, subagentId) =>
    Effect.gen(function* () {
      if (subagents.get(threadId)?.get(subagentId)?.status !== "running") return
      const run = agentRuns.get(subagentId)
      if (run !== undefined) return yield* run.stop
      const { provider: id } = yield* threads.get(threadId)
      const stop = providers[id].stopSubagent
      if (stop === undefined) {
        return yield* new AgentError({ provider: id, message: "This agent cannot stop a single sub-agent" })
      }
      yield* stop(threadId, subagentId)
      const endedAt = yield* nowIso
      const latest = subagents.get(threadId)?.get(subagentId)
      if (latest?.status === "running") yield* updateSubagent(threadId, { ...latest, status: "stopped", endedAt })
    })

  const stopBackgroundTask: AgentRunner["Service"]["stopBackgroundTask"] = (threadId, taskId) =>
    Effect.gen(function* () {
      const { provider: id } = yield* threads.get(threadId)
      const tasks = providers[id].backgroundTasks
      if (tasks === undefined) {
        return yield* new AgentError({ provider: id, message: "This agent cannot stop a background task" })
      }
      yield* tasks.stop(threadId, taskId)
    })

  const moveCommandToBackground: AgentRunner["Service"]["moveCommandToBackground"] = (threadId, callId) =>
    Effect.gen(function* () {
      const { provider: id } = yield* threads.get(threadId)
      const moveCommand = providers[id].backgroundTasks?.moveCommand
      if (moveCommand === undefined) {
        return yield* new AgentError({ provider: id, message: "This agent cannot move a command to the background" })
      }
      return yield* moveCommand(threadId, callId)
    })

  const hasPendingWakeup = (threadId: string) =>
    (backgroundTasks.get(threadId) ?? []).some((task) => task.kind === "wakeup")

  const closeSessionAfterTurn = (threadId: string) =>
    Effect.gen(function* () {
      const turn = yield* FiberMap.get(turns, threadId)
      if (Option.isSome(turn)) yield* Fiber.await(turn.value)
      yield* Effect.gen(function* () {
        if (busyThreads.has(threadId) || !hasPendingWakeup(threadId)) return
        yield* closeProviderSession(yield* threads.get(threadId))
      }).pipe(exclusive(threadId))
    }).pipe(Effect.catch((error) => Effect.logError("failed to retire the wakeup of a stopped thread", error)))

  const stopSubagentsAndTasks = (threadId: string, stops: (task: BackgroundTask) => boolean) =>
    Effect.gen(function* () {
      const running = listSubagents(threadId).filter((subagent) => subagent.status === "running")
      yield* Effect.forEach(running, (subagent) => stopSubagent(threadId, subagent.id).pipe(Effect.ignore), {
        discard: true,
      })
      const tasks = (backgroundTasks.get(threadId) ?? []).filter((task) => task.kind !== "wakeup" && stops(task))
      yield* Effect.forEach(tasks, (task) => stopBackgroundTask(threadId, task.id).pipe(Effect.ignore), {
        discard: true,
      })
    })

  const stopBackgroundWork = (threadId: string) =>
    Effect.gen(function* () {
      yield* stopSubagentsAndTasks(threadId, (task) => task.kind !== "shell")
      if (hasPendingWakeup(threadId)) yield* Effect.forkIn(closeSessionAfterTurn(threadId), scope)
    })

  const release = <A, E>(threadId: string, whileIdle: Effect.Effect<A, E>) =>
    Effect.gen(function* () {
      if (isBusy(threadId)) return Option.none<A>()
      yield* stopSubagentsAndTasks(threadId, () => true)
      return yield* Effect.gen(function* () {
        if (isBusy(threadId)) return Option.none<A>()
        yield* threads.get(threadId).pipe(
          Effect.flatMap(closeProviderSession),
          Effect.catch((error) => Effect.logWarning("failed to close the session of a settled thread", error)),
        )
        return Option.some(yield* whileIdle)
      }).pipe(exclusive(threadId))
    })

  const interrupt = (threadId: string) =>
    stopBackgroundWork(threadId).pipe(
      Effect.andThen(
        Effect.suspend(() => {
          const turn = activeTurns.get(threadId)
          if (turn !== undefined) return turn.interrupt
          const pending = pendingSends.get(threadId)
          return pending === undefined ? Effect.void : Deferred.succeed(pending, undefined).pipe(Effect.asVoid)
        }),
      ),
    )

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

  const warm = (threadId: string) =>
    Effect.gen(function* () {
      if (isBusy(threadId)) return
      const thread = yield* threads.get(threadId)
      if (thread.status === "archived") return
      if (thread.sideOf !== null && !(yield* threads.started(threadId))) return
      const provider = providers[thread.provider]
      if (provider.warm === undefined) return
      const home = yield* accounts.home(thread.accountId)
      const workspace = yield* activeWorkspace(threadId)
      const environment = yield* readEnvironment(thread, workspace)
      yield* provider.warm(yield* sessionInput(thread, provider, workspace.cwd, home, environment))
    }).pipe(Effect.catchCause((cause) => Effect.logWarning("failed to warm the agent session", cause)))

  return AgentRunner.of({
    send,
    queue,
    unqueue,
    schedule,
    reschedule,
    unschedule,
    sendDueSchedules,
    resume,
    resumeAtReset,
    switchAccount,
    removeAccount,
    switchAgent,
    steer: (threadId, text, attachments) =>
      steerWhen({ threadId, text, attachments, when: Effect.succeed(true) }).pipe(Effect.asVoid),
    steerWhen,
    interrupt,
    stop: (threadId) =>
      interrupt(threadId).pipe(
        Effect.andThen(FiberMap.get(turns, threadId)),
        Effect.flatMap(Option.match({ onNone: () => Effect.void, onSome: Fiber.await })),
        Effect.asVoid,
      ),
    isBusy: (threadId) => Effect.sync(() => isBusy(threadId)),
    release,
    warm,
    setAccessMode: (threadId, accessMode) =>
      Effect.gen(function* () {
        const turn = activeTurns.get(threadId)
        if (turn === undefined) return
        yield* turn.provider.setAccessMode(threadId, accessMode)
        if (accessMode !== "full") return
        for (const request of approvals.values()) {
          if (request.threadId === threadId) yield* respondApproval(request.id, "allow").pipe(Effect.orDie)
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
        return {
          messages: yield* liveMessages(threadId),
          approvals: [...approvals.values()].filter((request) => request.threadId === threadId),
          questions: [...questions.values()].filter((request) => request.threadId === threadId),
          secretRequests: [...secretRequests.values()]
            .map(({ request }) => request)
            .filter((request) => request.threadId === threadId),
          seq: transcriptSeqs.get(threadId) ?? 0,
          sequenceScope: "thread" as const,
        }
      }).pipe(exclusive(threadId)),
    toolOutput: (call) => {
      const live = activeTurns
        .get(call.threadId)
        ?.messages()
        .filter((message) => call.messageId === undefined || message.id === call.messageId)
        .flatMap((message) => message.parts)
        .find((part) => part.type === "tool_call" && part.callId === call.callId)
      const persisted = messages.toolOutput(call).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.fail(new NotFoundError({ entity: "tool call", id: call.callId })),
            onSome: Effect.succeed,
          }),
        ),
      )
      return live?.type === "tool_call" && live.output !== undefined ? Effect.succeed(live.output) : persisted
    },
    listModels: (id) => providers[id].listModels,
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
    runAgent,
    waitForAgent,
    stopSubagent,
    backgroundTasks: (threadId) => Effect.sync(() => backgroundTasks.get(threadId) ?? []),
    stopBackgroundTask,
    moveCommandToBackground,
    listCommands: (threadId) =>
      Effect.gen(function* () {
        const thread = yield* threads.get(threadId)
        const { cwd } = yield* activeWorkspace(threadId)
        const home = yield* accounts.home(thread.accountId)
        return withDocumentCommand(yield* providers[thread.provider].listCommands({ threadId, cwd, home }))
      }),
    listProjectCommands: (projectId, provider) =>
      Effect.gen(function* () {
        const { rootPath } = yield* projects.get(projectId)
        const home = yield* accounts.home((yield* settings.get).defaultAccount[provider])
        return withDocumentCommand(
          yield* providers[provider].listCommands({ threadId: `project:${projectId}`, cwd: rootPath, home }),
        )
      }),
  })
})

export const layer = Layer.effect(AgentRunner, make)
