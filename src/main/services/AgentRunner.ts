import { randomUUID } from "node:crypto"
import { Context, Deferred, Effect, FiberMap, Layer, Semaphore, Stream } from "effect"
import type { RpcResponse, TranscriptPush } from "../../shared/contract.ts"
import type {
  AgentCommand,
  AgentEvent,
  ApprovalDecision,
  ApprovalRequest,
  ModelInfo,
  ProviderId,
  Subagent,
  SecretRequest,
} from "../../shared/agent.ts"
import type { AccessMode, Attachment, Message, Thread, ThreadStatus } from "../../shared/domain.ts"
import { isThreadBusy } from "../../shared/domain.ts"
import { foldTranscript } from "../../shared/foldEvent.ts"
import { ClaudeProvider } from "../agents/claude/index.ts"
import { CodexProvider } from "../agents/codex/index.ts"
import { McpCredentials } from "../mcp/credentials.ts"
import { AgentError, type AgentProvider } from "../agents/provider.ts"
import { Events } from "./Events.ts"
import { nowIso } from "./clock.ts"
import type { NotFoundError, PersistenceError, ThreadStartedError, WorktreeTakenError } from "./errors.ts"
import type { CommandError } from "./Git.ts"
import { Messages } from "./Messages.ts"
import { Secrets } from "./Secrets.ts"
import { ThreadNaming } from "./ThreadNaming.ts"
import { Threads } from "./Threads.ts"
import { Worktrees } from "./Worktrees.ts"
import { makeActiveWorkspace } from "./workspace.ts"

const PERSIST_INTERVAL_MS = 500

export interface SendOptions {
  /** Only with the first message: moves the thread into a new worktree forked from `baseRef` first. */
  readonly worktree?: { readonly baseRef: string } | undefined
}

type SendError = AgentError | PersistenceError | NotFoundError | CommandError | WorktreeTakenError | ThreadStartedError

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
    readonly interrupt: (threadId: string) => Effect.Effect<void>
    readonly resumeAtReset: (
      threadId: string,
      enabled: boolean,
    ) => Effect.Effect<Thread, AgentError | PersistenceError | NotFoundError | ThreadStartedError>
    /** Reaches a running turn where the agent supports it; otherwise the next turn starts in the new mode. */
    readonly setAccessMode: (threadId: string, accessMode: AccessMode) => Effect.Effect<void, AgentError>
    readonly respondApproval: (requestId: string, decision: ApprovalDecision) => Effect.Effect<void>
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
    /** Sub-agents the thread's agent spawned since the app started, newest first. */
    readonly subagents: (threadId: string) => Effect.Effect<ReadonlyArray<Subagent>>
    readonly listCommands: (
      threadId: string,
    ) => Effect.Effect<ReadonlyArray<AgentCommand>, AgentError | PersistenceError | NotFoundError>
  }
>()("kkcode/AgentRunner") {}

/** Thread status a turn moves to on this event, if any. */
const statusAfter = (event: AgentEvent): ThreadStatus | undefined => {
  switch (event.type) {
    case "approval_requested":
    case "secret_requested":
      return "awaiting_approval"
    case "approval_resolved":
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

const replaceLast = (messages: ReadonlyArray<Message>, message: Message) => [...messages.slice(0, -1), message]

const make = Effect.gen(function* () {
  const scope = yield* Effect.scope
  const threads = yield* Threads
  const worktrees = yield* Worktrees
  const messages = yield* Messages
  const push = yield* Events
  const mcp = yield* McpCredentials
  const secrets = yield* Secrets
  const naming = yield* ThreadNaming
  const activeWorkspace = yield* makeActiveWorkspace

  const providers: Record<ProviderId, AgentProvider> = {
    claude: yield* ClaudeProvider,
    codex: yield* CodexProvider,
  }

  const turns = yield* FiberMap.make<string>()
  const busyThreads = new Set<string>()
  const activeTurns = new Map<string, ReturnType<typeof makeTurn>>()
  const approvals = new Map<string, ApprovalRequest>()
  const secretRequests = new Map<
    string,
    { readonly request: SecretRequest; readonly answer: Deferred.Deferred<"stored" | "declined", AgentError> }
  >()
  const threadLocks = new Map<string, Semaphore.Semaphore>()
  /** Latest state of each sub-agent per thread, in spawn order. Kept in memory only, so it ends with the app. */
  const subagents = new Map<string, Map<string, Subagent>>()
  let seq = 0

  // Nothing runs at boot, so whatever a killed app left running is over.
  yield* threads.resetInterrupted
  yield* messages.closeInterrupted

  const providerFor = (id: ProviderId) => Effect.succeed(providers[id])

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

  const publishTranscript = (event: DistributiveOmit<TranscriptPush, "seq">) => push.publish({ ...event, seq: ++seq })

  const insertMessage = (message: Message) =>
    messages.insert(message).pipe(Effect.andThen(publishTranscript({ type: "message.created", message })))

  /**
   * One turn streaming into its assistant messages. A turn starts with one assistant message; each
   * steer closes it and opens another after the steer's user message, so ordering by createdAt keeps
   * the transcript in the order things happened.
   */
  const makeTurn = (thread: Thread, provider: AgentProvider, cwd: string, initial: Message) => {
    let turnMessages: ReadonlyArray<Message> = [initial]
    let status: ThreadStatus = "running"
    let persistedAt = Date.now()
    const dirty = new Set<string>()

    const persist = Effect.suspend(() => {
      const changed = turnMessages.filter((message) => dirty.has(message.id))
      dirty.clear()
      persistedAt = Date.now()
      return Effect.forEach(changed, messages.update, { discard: true })
    })

    const setTurnMessages = (next: ReadonlyArray<Message>) => {
      next.forEach((message, index) => message !== turnMessages[index] && dirty.add(message.id))
      turnMessages = next
    }

    const handle = (event: AgentEvent) =>
      Effect.gen(function* () {
        if (event.type === "subagent_updated") return yield* updateSubagent(thread.id, event.subagent)
        yield* publishTranscript({ type: "thread.event", threadId: thread.id, event })
        setTurnMessages(foldTranscript(turnMessages, event, yield* nowIso))

        if (event.type === "approval_requested") approvals.set(event.request.id, event.request)
        if (event.type === "approval_resolved") approvals.delete(event.requestId)
        if (event.type === "session_bound" && event.providerSessionId !== thread.providerSessionId) {
          yield* updateThread({ id: thread.id, providerSessionId: event.providerSessionId })
        }
        const nextStatus = statusAfter(event)
        if (nextStatus !== undefined && nextStatus !== status) {
          status = nextStatus
          yield* updateThread({
            id: thread.id,
            status,
            ...(event.type === "turn_limited" ? { usageLimit: event.limit } : {}),
          })
        }
        if (dirty.size > 0 && Date.now() - persistedAt >= PERSIST_INTERVAL_MS) yield* persist
      }).pipe(exclusive(thread.id))

    const steer = (text: string, attachments: ReadonlyArray<Attachment>) =>
      Effect.gen(function* () {
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
      }).pipe(exclusive(thread.id))

    const finish = Effect.gen(function* () {
      for (const [id, request] of approvals) if (request.threadId === thread.id) approvals.delete(id)
      for (const [id, { request, answer }] of secretRequests) {
        if (request.threadId !== thread.id) continue
        secretRequests.delete(id)
        yield* Deferred.fail(
          answer,
          new AgentError({ provider: "kkcode", message: "The turn ended before the user answered." }),
        )
      }
      const last = turnMessages.at(-1)!
      if (last.completedAt === null) setTurnMessages(replaceLast(turnMessages, { ...last, completedAt: yield* nowIso }))
      yield* persist
      if (isThreadBusy(status)) yield* updateThread({ id: thread.id, status: "idle" })
    }).pipe(
      Effect.catch((error) => Effect.logError("failed to finish turn", error)),
      Effect.ensuring(
        Effect.sync(() => {
          busyThreads.delete(thread.id)
          activeTurns.delete(thread.id)
        }),
      ),
      exclusive(thread.id),
    )

    /** Never fails: provider errors become turn_failed. */
    const run = (prompt: string, attachments: ReadonlyArray<Attachment>) =>
      Effect.flatMap(mcp.connectionFor(thread.id), (mcpServer) =>
        provider
          .runTurn({
            threadId: thread.id,
            prompt,
            attachments,
            cwd,
            model: thread.model,
            effort: thread.effort,
            fastMode: thread.fastMode,
            accessMode: thread.accessMode,
            resumeSessionId: thread.providerSessionId,
            mcpServer,
          })
          .pipe(Stream.runForEach(handle)),
      ).pipe(
        Effect.catchTag("AgentError", (error) => handle({ type: "turn_failed", message: error.message })),
        Effect.catch((error) => Effect.logError("turn bookkeeping failed", error)),
        Effect.ensuring(finish),
      )

    return { provider, steer, run, handle, messages: () => turnMessages }
  }

  const startTurn = (threadId: string, prompt: string, attachments: ReadonlyArray<Attachment>, options: SendOptions) =>
    Effect.gen(function* () {
      let thread = yield* threads.get(threadId)
      const first = !(yield* threads.started(threadId))
      if (options.worktree) {
        thread = yield* threads.attachWorktree(threadId, options.worktree.baseRef)
        yield* push.publish({ type: "thread.updated", thread })
      }
      const provider = yield* providerFor(thread.provider)
      // Marking the thread running in the same critical section as resolving its cwd stops a
      // worktree removal from deleting the directory this turn is about to run in.
      const turn = yield* worktrees.exclusive(
        Effect.gen(function* () {
          const { cwd } = yield* activeWorkspace(thread.id)
          const now = yield* nowIso
          const assistant = openAssistantMessage(threadId, now)
          yield* insertMessage(userMessage(threadId, prompt, attachments, now))
          yield* insertMessage(assistant)
          yield* updateThread({ id: threadId, status: "running" })
          return makeTurn(thread, provider, cwd, assistant)
        }),
      )
      activeTurns.set(threadId, turn)
      yield* FiberMap.run(turns, threadId, turn.run(prompt, attachments))
      // Automations title their threads from their own template.
      if (first && thread.createdBy === "user" && prompt.trim() !== "")
        yield* Effect.forkDetach(naming.nameFromPrompt(thread, prompt))
    }).pipe(exclusive(threadId))

  const send = (
    threadId: string,
    prompt: string,
    attachments: ReadonlyArray<Attachment>,
    options: SendOptions = {},
  ): Effect.Effect<void, SendError> =>
    Effect.gen(function* () {
      if (busyThreads.has(threadId)) {
        return yield* new AgentError({ provider: "kkcode", message: "A turn is already running on this thread" })
      }
      // Claimed before the first await so two quick sends cannot both start a turn.
      busyThreads.add(threadId)
      yield* startTurn(threadId, prompt, attachments, options).pipe(
        Effect.onError(() => Effect.sync(() => busyThreads.delete(threadId))),
      )
    })

  const resumeAtReset = (threadId: string, enabled: boolean) =>
    Effect.gen(function* () {
      const thread = yield* threads.get(threadId)
      const limit = thread.usageLimit
      if (thread.status !== "limited" || limit?.kind !== "usage" || limit.reset === null) {
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
        limit?.kind !== "usage" ||
        !limit.reset?.autoResume ||
        limit.reset.at > now
      )
        return
      yield* updateThread({ id: thread.id, usageLimit: { ...limit, reset: { ...limit.reset, autoResume: false } } })
      return (yield* messages.list(thread.id)).findLast((message) => message.role === "user")
    }).pipe(exclusive(threadId))

  const resumeDue = Effect.gen(function* () {
    const now = yield* nowIso
    for (const candidate of yield* threads.list) {
      yield* Effect.gen(function* () {
        const prompt = yield* consumeDueResume(candidate.id, now)
        if (prompt === undefined) return
        const text = prompt.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n")
        const attachments = prompt.parts.flatMap((part) => (part.type === "attachment" ? [part.attachment] : []))
        yield* send(candidate.id, text, attachments)
      }).pipe(Effect.catch((error) => Effect.logWarning("automatic resume failed", error)))
    }
  })

  yield* Effect.forkIn(
    Effect.forever(
      resumeDue.pipe(
        Effect.catch((error) => Effect.logWarning("limit reset check failed", error)),
        Effect.andThen(Effect.sleep("1 second")),
      ),
    ),
    scope,
  )

  const requestSecret = (threadId: string, name: string, description: string) =>
    Effect.gen(function* () {
      const turn = activeTurns.get(threadId)
      if (turn === undefined) {
        return yield* new AgentError({ provider: "kkcode", message: "No turn is running on this thread." })
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
    resumeAtReset,
    steer: (threadId, text, attachments) =>
      Effect.suspend(() => activeTurns.get(threadId)?.steer(text, attachments) ?? send(threadId, text, attachments)),
    interrupt: (threadId) =>
      Effect.suspend(() => activeTurns.get(threadId)?.provider.interrupt(threadId) ?? Effect.void),
    setAccessMode: (threadId, accessMode) =>
      Effect.suspend(() => activeTurns.get(threadId)?.provider.setAccessMode(threadId, accessMode) ?? Effect.void),
    respondApproval: (requestId, decision) =>
      Effect.suspend(() => {
        const request = approvals.get(requestId)
        if (request === undefined) return Effect.void
        return providers[request.provider]?.respondApproval(requestId, decision) ?? Effect.void
      }),
    requestSecret,
    respondSecret,
    // The database lags a running turn by up to PERSIST_INTERVAL_MS, so its messages come from memory.
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
          secretRequests: [...secretRequests.values()]
            .map(({ request }) => request)
            .filter((request) => request.threadId === threadId),
          seq,
        }
      }).pipe(exclusive(threadId)),
    listModels: (id) => providers[id]?.listModels ?? Effect.succeed([]),
    subagents: (threadId) => Effect.sync(() => listSubagents(threadId)),
    listCommands: (threadId) =>
      Effect.gen(function* () {
        const thread = yield* threads.get(threadId)
        const { cwd } = yield* activeWorkspace(threadId)
        return yield* providers[thread.provider].listCommands({ threadId, cwd })
      }),
  })
})

export const layer = Layer.effect(AgentRunner, make)
