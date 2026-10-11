import { randomUUID } from "node:crypto"
import { Context, Effect, FiberMap, Layer, Stream } from "effect"
import type { AgentEvent, ApprovalDecision, ApprovalRequest, ModelInfo, ProviderId } from "../../shared/agent.ts"
import type { Message, Thread, ThreadStatus } from "../../shared/domain.ts"
import { foldEvent } from "../../shared/foldEvent.ts"
import { ClaudeProvider } from "../agents/claude/index.ts"
import { CodexProvider } from "../agents/codex/index.ts"
import { McpServerUrl } from "../agents/mcp.ts"
import { AgentError, type AgentProvider } from "../agents/provider.ts"
import { Events } from "./Events.ts"
import { nowIso } from "./clock.ts"
import type { NotFoundError, PersistenceError } from "./errors.ts"
import { Messages } from "./Messages.ts"
import { Projects } from "./Projects.ts"
import { Threads } from "./Threads.ts"

const PERSIST_INTERVAL_MS = 500

export class AgentRunner extends Context.Service<
  AgentRunner,
  {
    /** Starts a turn in the background. Fails if the thread already has one in flight. */
    readonly send: (
      threadId: string,
      prompt: string,
    ) => Effect.Effect<void, AgentError | PersistenceError | NotFoundError>
    readonly interrupt: (threadId: string) => Effect.Effect<void>
    readonly respondApproval: (requestId: string, decision: ApprovalDecision) => Effect.Effect<void>
    readonly pendingApprovals: (threadId: string) => Effect.Effect<ReadonlyArray<ApprovalRequest>>
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

const make = Effect.gen(function* () {
  const threads = yield* Threads
  const projects = yield* Projects
  const messages = yield* Messages
  const push = yield* Events
  const mcpServerUrl = yield* McpServerUrl

  const providers: Record<ProviderId, AgentProvider> = {
    claude: yield* ClaudeProvider,
    codex: yield* CodexProvider,
  }

  const turns = yield* FiberMap.make<string>()
  const busyThreads = new Set<string>()
  const activeProviders = new Map<string, AgentProvider>()
  const approvals = new Map<string, ApprovalRequest>()

  yield* threads.resetInterrupted

  const providerFor = (id: ProviderId) => Effect.succeed(providers[id])

  const updateThread = (input: Parameters<typeof threads.update>[0]) =>
    threads.update(input).pipe(Effect.flatMap((thread) => push.publish({ type: "thread.updated", thread })))

  const insertMessage = (message: Message) =>
    messages.insert(message).pipe(Effect.andThen(push.publish({ type: "message.created", message })))

  /** Streams one turn into the assistant message. Never fails: provider errors become turn_failed. */
  const runTurn = (thread: Thread, provider: AgentProvider, prompt: string, cwd: string, initial: Message) => {
    let assistant = initial
    let status: ThreadStatus = "running"
    let persistedAt = Date.now()
    let dirty = false

    const persist = Effect.suspend(() => {
      dirty = false
      persistedAt = Date.now()
      return messages.update(assistant)
    })

    const handle = (event: AgentEvent) =>
      Effect.gen(function* () {
        yield* push.publish({ type: "thread.event", threadId: thread.id, event })
        const next = foldEvent(assistant, event, yield* nowIso)
        if (next !== assistant) dirty = true
        assistant = next

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
        if (dirty && Date.now() - persistedAt >= PERSIST_INTERVAL_MS) yield* persist
      })

    const finish = Effect.gen(function* () {
      for (const [id, request] of approvals) if (request.threadId === thread.id) approvals.delete(id)
      if (assistant.completedAt === null) assistant = { ...assistant, completedAt: yield* nowIso }
      yield* persist
      if (status !== "idle") yield* updateThread({ id: thread.id, status: "idle" })
    }).pipe(
      Effect.catch((error) => Effect.logError("failed to finish turn", error)),
      Effect.ensuring(
        Effect.sync(() => {
          busyThreads.delete(thread.id)
          activeProviders.delete(thread.id)
        }),
      ),
    )

    return provider
      .runTurn({
        threadId: thread.id,
        prompt,
        cwd,
        model: thread.model,
        resumeSessionId: thread.providerSessionId,
        mcpServerUrl,
      })
      .pipe(
        Stream.runForEach(handle),
        Effect.catchTag("AgentError", (error) => handle({ type: "turn_failed", message: error.message })),
        Effect.catch((error) => Effect.logError("turn bookkeeping failed", error)),
        Effect.ensuring(finish),
      )
  }

  const startTurn = (threadId: string, prompt: string) =>
    Effect.gen(function* () {
      const thread = yield* threads.get(threadId)
      const provider = yield* providerFor(thread.provider)
      const cwd = yield* threads.resolveCwd(thread.id)
      const now = yield* nowIso
      const user: Message = {
        id: randomUUID(),
        threadId,
        role: "user",
        parts: [{ type: "text", text: prompt }],
        createdAt: now,
        completedAt: now,
        usage: null,
      }
      const assistant: Message = { ...user, id: randomUUID(), role: "assistant", parts: [], completedAt: null }
      yield* insertMessage(user)
      yield* insertMessage(assistant)
      yield* updateThread({ id: threadId, status: "running" })

      activeProviders.set(threadId, provider)
      yield* FiberMap.run(turns, threadId, runTurn(thread, provider, prompt, cwd, assistant))
    })

  const send = (threadId: string, prompt: string) =>
    Effect.gen(function* () {
      if (busyThreads.has(threadId)) {
        return yield* new AgentError({ provider: "kkcode", message: "A turn is already running on this thread" })
      }
      // Claimed before the first await so two quick sends cannot both start a turn.
      busyThreads.add(threadId)
      yield* startTurn(threadId, prompt).pipe(Effect.onError(() => Effect.sync(() => busyThreads.delete(threadId))))
    })

  return AgentRunner.of({
    send,
    interrupt: (threadId) => Effect.suspend(() => activeProviders.get(threadId)?.interrupt(threadId) ?? Effect.void),
    respondApproval: (requestId, decision) =>
      Effect.suspend(() => {
        const request = approvals.get(requestId)
        if (request === undefined) return Effect.void
        return providers[request.provider]?.respondApproval(requestId, decision) ?? Effect.void
      }),
    pendingApprovals: (threadId) =>
      Effect.sync(() => [...approvals.values()].filter((request) => request.threadId === threadId)),
    listModels: (id) => providers[id]?.listModels ?? Effect.succeed([]),
  })
})

export const layer = Layer.effect(AgentRunner, make)
