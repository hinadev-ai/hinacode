import { randomUUID } from "node:crypto"
import { Context, Effect, FiberMap, Layer, Semaphore, Stream } from "effect"
import type { RpcResponse, TranscriptPush } from "../../shared/contract.ts"
import type { AgentEvent, ApprovalDecision, ApprovalRequest, ModelInfo, ProviderId } from "../../shared/agent.ts"
import type { Attachment, Message, Thread, ThreadStatus } from "../../shared/domain.ts"
import { foldTranscript } from "../../shared/foldEvent.ts"
import { ClaudeProvider } from "../agents/claude/index.ts"
import { CodexProvider } from "../agents/codex/index.ts"
import { McpServer } from "../mcp/index.ts"
import { AgentError, type AgentProvider } from "../agents/provider.ts"
import { Events } from "./Events.ts"
import { nowIso } from "./clock.ts"
import type { NotFoundError, PersistenceError } from "./errors.ts"
import { Messages } from "./Messages.ts"
import { Projects } from "./Projects.ts"
import { Threads } from "./Threads.ts"
import { makeActiveWorkspace } from "./workspace.ts"

const PERSIST_INTERVAL_MS = 500

export class AgentRunner extends Context.Service<
  AgentRunner,
  {
    /** Starts a turn in the background. Fails if the thread already has one in flight. */
    readonly send: (
      threadId: string,
      prompt: string,
      attachments: ReadonlyArray<Attachment>,
    ) => Effect.Effect<void, AgentError | PersistenceError | NotFoundError>
    /** Adds input to the thread's running turn, or starts a turn when none is running. */
    readonly steer: (
      threadId: string,
      text: string,
      attachments: ReadonlyArray<Attachment>,
    ) => Effect.Effect<void, AgentError | PersistenceError | NotFoundError>
    readonly interrupt: (threadId: string) => Effect.Effect<void>
    readonly respondApproval: (requestId: string, decision: ApprovalDecision) => Effect.Effect<void>
    readonly transcript: (threadId: string) => Effect.Effect<RpcResponse<"threads.transcript">, PersistenceError>
    readonly listModels: (provider: ProviderId) => Effect.Effect<ReadonlyArray<ModelInfo>, AgentError>
  }
>()("kkcode/AgentRunner") {}

/** Thread status a turn moves to on this event, if any. */
const statusAfter = (event: AgentEvent): ThreadStatus | undefined => {
  switch (event.type) {
    case "approval_requested":
      return "awaiting_approval"
    case "approval_resolved":
      return "running"
    case "turn_completed":
    case "turn_failed":
      return "idle"
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
  const threads = yield* Threads
  const projects = yield* Projects
  const messages = yield* Messages
  const push = yield* Events
  const mcp = yield* McpServer
  const activeWorkspace = yield* makeActiveWorkspace

  const providers: Record<ProviderId, AgentProvider> = {
    claude: yield* ClaudeProvider,
    codex: yield* CodexProvider,
  }

  const turns = yield* FiberMap.make<string>()
  const busyThreads = new Set<string>()
  const activeTurns = new Map<string, ReturnType<typeof makeTurn>>()
  const approvals = new Map<string, ApprovalRequest>()
  const threadLocks = new Map<string, Semaphore.Semaphore>()
  let seq = 0

  // Nothing runs at boot, so whatever a killed app left running is over.
  yield* threads.resetInterrupted
  yield* messages.closeInterrupted

  const providerFor = (id: ProviderId) => Effect.succeed(providers[id])

  const updateThread = (input: Parameters<typeof threads.update>[0]) =>
    threads.update(input).pipe(Effect.flatMap((thread) => push.publish({ type: "thread.updated", thread })))

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
    projectTrusted: boolean,
    initial: Message,
  ) => {
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
          yield* updateThread({ id: thread.id, status })
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
      const last = turnMessages.at(-1)!
      if (last.completedAt === null) setTurnMessages(replaceLast(turnMessages, { ...last, completedAt: yield* nowIso }))
      yield* persist
      if (status !== "idle") yield* updateThread({ id: thread.id, status: "idle" })
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
      provider
        .runTurn({
          threadId: thread.id,
          prompt,
          attachments,
          cwd,
          projectTrusted,
          model: thread.model,
          resumeSessionId: thread.providerSessionId,
          mcpServerUrl: mcp.urlForThread(thread.id),
        })
        .pipe(
          Stream.runForEach(handle),
          Effect.catchTag("AgentError", (error) => handle({ type: "turn_failed", message: error.message })),
          Effect.catch((error) => Effect.logError("turn bookkeeping failed", error)),
          Effect.ensuring(finish),
        )

    return { provider, steer, run, messages: () => turnMessages }
  }

  const startTurn = (threadId: string, prompt: string, attachments: ReadonlyArray<Attachment>) =>
    Effect.gen(function* () {
      const thread = yield* threads.get(threadId)
      const provider = yield* providerFor(thread.provider)
      const { cwd } = yield* activeWorkspace(thread.id)
      const project = yield* projects.get(thread.projectId)
      const now = yield* nowIso
      const assistant = openAssistantMessage(threadId, now)
      yield* insertMessage(userMessage(threadId, prompt, attachments, now))
      yield* insertMessage(assistant)
      yield* updateThread({ id: threadId, status: "running" })

      const turn = makeTurn(thread, provider, cwd, project.trusted, assistant)
      activeTurns.set(threadId, turn)
      yield* FiberMap.run(turns, threadId, turn.run(prompt, attachments))
    }).pipe(exclusive(threadId))

  const send = (threadId: string, prompt: string, attachments: ReadonlyArray<Attachment>) =>
    Effect.gen(function* () {
      if (busyThreads.has(threadId)) {
        return yield* new AgentError({ provider: "kkcode", message: "A turn is already running on this thread" })
      }
      // Claimed before the first await so two quick sends cannot both start a turn.
      busyThreads.add(threadId)
      yield* startTurn(threadId, prompt, attachments).pipe(
        Effect.onError(() => Effect.sync(() => busyThreads.delete(threadId))),
      )
    })

  return AgentRunner.of({
    send,
    steer: (threadId, text, attachments) =>
      Effect.suspend(() => activeTurns.get(threadId)?.steer(text, attachments) ?? send(threadId, text, attachments)),
    interrupt: (threadId) =>
      Effect.suspend(() => activeTurns.get(threadId)?.provider.interrupt(threadId) ?? Effect.void),
    respondApproval: (requestId, decision) =>
      Effect.suspend(() => {
        const request = approvals.get(requestId)
        if (request === undefined) return Effect.void
        return providers[request.provider]?.respondApproval(requestId, decision) ?? Effect.void
      }),
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
          seq,
        }
      }).pipe(exclusive(threadId)),
    listModels: (id) => providers[id]?.listModels ?? Effect.succeed([]),
  })
})

export const layer = Layer.effect(AgentRunner, make)
