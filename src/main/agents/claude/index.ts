import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { readFile } from "node:fs/promises"
import {
  query,
  type CanUseTool,
  type Options,
  type PermissionResult,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk"
import { Cause, Context, Deferred, Duration, Effect, Layer, Queue, Stream } from "effect"
import type { AgentEvent, ApprovalDecision, ApprovalKind, ModelInfo, RunTurnInput } from "../../../shared/agent.ts"
import type { Attachment } from "../../../shared/domain.ts"
import { AgentError, type AgentProvider } from "../provider.ts"
import { isTerminal, mapMessage, type MapState } from "./mapMessage.ts"

export class ClaudeProvider extends Context.Service<ClaudeProvider, AgentProvider>()("kkcode/agents/ClaudeProvider") {}

const FALLBACK_MODELS: ReadonlyArray<ModelInfo> = [
  { id: "claude-opus-5-5", label: "Opus 5.5", provider: "claude" },
  { id: "claude-fable-5-1", label: "Fable 5.1", provider: "claude" },
  { id: "claude-sonnet-5-5", label: "Sonnet 5.5", provider: "claude" },
  { id: "claude-haiku-5-5", label: "Haiku 5.5", provider: "claude" },
]

type TurnQueue = Queue.Queue<AgentEvent, AgentError | Cause.Done>

/** One long-lived `query()` per thread; follow-up prompts are fed into the same CLI process. */
interface Session extends MapState {
  readonly threadId: string
  readonly cwd: string
  readonly mcpServerUrl: string
  readonly prompts: Queue.Queue<SDKUserMessage>
  readonly abort: AbortController
  readonly sessionAllowedTools: Set<string>
  readonly query: Query
  model: string
  sessionId: string | null
  turn: TurnQueue | null
  interrupted: boolean
  /** Steer prompts sent during the current turn; each makes the CLI end its in-flight response with an aborted result. */
  pendingSteers: number
  /** Turns whose consumer left before their result; their remaining messages must not reach the next turn. */
  abandonedTurns: number
}

interface PendingApproval {
  readonly session: Session
  readonly toolName: string
  readonly deferred: Deferred.Deferred<ApprovalDecision>
}

const agentError = (message: string) => (cause: unknown) =>
  new AgentError({
    provider: "claude",
    message: `${message}: ${cause instanceof Error ? cause.message : String(cause)}`,
  })

/**
 * GUI-launched Electron apps (notably on macOS) get a minimal PATH, so fall back to a login shell
 * to find the user's `claude` install.
 */
function resolveClaudeExecutable(): string | undefined {
  const attempts: Array<[string, Array<string>]> = [
    ["which", ["claude"]],
    [process.env.SHELL ?? "/bin/sh", ["-lc", "command -v claude"]],
  ]
  for (const [command, args] of attempts) {
    try {
      const path = execFileSync(command, args, { encoding: "utf8", timeout: 5000 }).trim()
      if (path !== "") return path
    } catch {
      // try the next strategy
    }
  }
  return undefined
}

function approvalKind(toolName: string): ApprovalKind {
  if (toolName === "Bash") return "command"
  if (["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(toolName)) return "patch"
  return "tool"
}

function approvalDetail(input: Record<string, unknown>): string {
  const summary = input.command ?? input.file_path ?? input.notebook_path ?? input.url
  return typeof summary === "string" ? summary : JSON.stringify(input)
}

/** The Messages API rejects base64 images above 5 MB. */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024

type ContentBlock = Exclude<SDKUserMessage["message"]["content"], string>[number]
type ImageMediaType = Extract<Extract<ContentBlock, { type: "image" }>["source"], { type: "base64" }>["media_type"]

const IMAGE_MEDIA_TYPES: ReadonlyArray<string> = ["image/png", "image/jpeg", "image/gif", "image/webp"]
const isImageMediaType = (mime: string): mime is ImageMediaType => IMAGE_MEDIA_TYPES.includes(mime)

/** Images go inline as base64; other files are named by path so the agent reads them with its own tools. */
const attachmentBlock = (attachment: Attachment) =>
  Effect.gen(function* () {
    const fileBlock: ContentBlock = { type: "text", text: `Attached file: ${attachment.path}` }
    if (attachment.kind !== "image" || !isImageMediaType(attachment.mime)) return fileBlock
    if (attachment.bytes > MAX_IMAGE_BYTES) {
      return yield* new AgentError({
        provider: "claude",
        message: `${attachment.name} is larger than 5 MB, the limit for images sent to Claude`,
      })
    }
    const data = yield* Effect.tryPromise({
      try: () => readFile(attachment.path, "base64"),
      catch: agentError(`Cannot read ${attachment.name}`),
    })
    const block: ContentBlock = {
      type: "image",
      source: { type: "base64", media_type: attachment.mime, data },
    }
    return block
  })

const userMessage = (prompt: string, attachments: ReadonlyArray<Attachment>, priority?: SDKUserMessage["priority"]) =>
  Effect.gen(function* () {
    const blocks = yield* Effect.forEach(attachments, attachmentBlock)
    const content: SDKUserMessage["message"]["content"] =
      blocks.length === 0 ? prompt : [...(prompt === "" ? [] : [{ type: "text" as const, text: prompt }]), ...blocks]
    const message: SDKUserMessage = {
      type: "user",
      message: { role: "user", content },
      parent_tool_use_id: null,
      ...(priority === undefined ? {} : { priority }),
    }
    return message
  })

/** The CLI cuts the response short to pick up a `priority: "now"` prompt, then answers it under a new result. */
const isSteerAbort = (message: SDKMessage) =>
  message.type === "result" &&
  (message.terminal_reason === "aborted_streaming" || message.terminal_reason === "aborted_tools")

export const layer = Layer.effect(
  ClaudeProvider,
  Effect.gen(function* () {
    const layerScope = yield* Effect.scope
    const executable = resolveClaudeExecutable()
    const sessions = new Map<string, Session>()
    /** Last provider session id per thread, so a crashed CLI can be resumed without the caller's help. */
    const lastSessionIds = new Map<string, string>()
    const approvals = new Map<string, PendingApproval>()

    const baseOptions = (): Options => ({
      // The SDK replaces the child env instead of merging it.
      env: { ...process.env },
      ...(executable === undefined ? {} : { pathToClaudeCodeExecutable: executable }),
    })

    const emit = (session: Session, event: AgentEvent) => {
      if (session.turn === null) return
      if (event.type === "turn_failed" && session.interrupted) event = { type: "turn_failed", message: "Interrupted" }
      Queue.offerUnsafe(session.turn, event)
      if (isTerminal(event)) {
        Queue.endUnsafe(session.turn)
        session.turn = null
      }
    }

    const closeSession = (session: Session) =>
      Effect.sync(() => {
        if (sessions.get(session.threadId) === session) sessions.delete(session.threadId)
        Queue.shutdownUnsafe(session.prompts)
        session.abort.abort()
        session.query.close()
      })

    const askApproval = async (
      session: Session,
      toolName: string,
      input: Record<string, unknown>,
      options: Parameters<CanUseTool>[2],
    ): Promise<PermissionResult> => {
      if (session.sessionAllowedTools.has(toolName)) return { behavior: "allow", updatedInput: input }
      if (session.turn === null) return { behavior: "deny", message: "No active turn to approve this tool call" }

      const requestId = randomUUID()
      const deferred = Deferred.makeUnsafe<ApprovalDecision>()
      approvals.set(requestId, { session, toolName, deferred })
      const onAbort = () => Deferred.doneUnsafe(deferred, Effect.succeed("deny"))
      options.signal.addEventListener("abort", onAbort, { once: true })
      emit(session, {
        type: "approval_requested",
        request: {
          id: requestId,
          threadId: session.threadId,
          provider: "claude",
          kind: approvalKind(toolName),
          title: options.title ?? options.displayName ?? toolName,
          detail: options.description ?? approvalDetail(input),
          input,
        },
      })

      const decision = await Effect.runPromise(Deferred.await(deferred))
      options.signal.removeEventListener("abort", onAbort)
      approvals.delete(requestId)
      emit(session, { type: "approval_resolved", requestId })
      return decision === "deny"
        ? { behavior: "deny", message: "The user denied this tool call" }
        : { behavior: "allow", updatedInput: input }
    }

    /** Reads every SDK message of the session for its lifetime and routes it to the active turn. */
    const pump = (session: Session) =>
      Stream.fromAsyncIterable(
        // Iterate the Query itself: its return() closes the transport, the raw generator's does not.
        { [Symbol.asyncIterator]: () => session.query },
        agentError("Claude Code stream failed"),
      ).pipe(
        Stream.runForEach((message) =>
          Effect.sync(() => {
            // The CLI handles prompts in order, so everything up to an abandoned turn's result is stale.
            if (session.abandonedTurns > 0) {
              if (message.type === "result") session.abandonedTurns--
              return
            }
            if (session.pendingSteers > 0 && !session.interrupted && isSteerAbort(message)) {
              session.pendingSteers--
              return
            }
            if (message.type === "result") session.pendingSteers = 0
            if (message.type === "system" && message.subtype === "init") {
              session.sessionId = message.session_id
              lastSessionIds.set(session.threadId, message.session_id)
            }
            for (const event of mapMessage(message, session)) emit(session, event)
          }),
        ),
        Effect.catchCause((cause) =>
          Effect.sync(() => emit(session, { type: "turn_failed", message: Cause.pretty(cause) })),
        ),
        Effect.ensuring(
          Effect.suspend(() => {
            emit(session, {
              type: "turn_failed",
              message: "Claude Code session ended unexpectedly",
            })
            return closeSession(session)
          }),
        ),
      )

    const startSession = (input: RunTurnInput) =>
      Effect.gen(function* () {
        const prompts = yield* Queue.unbounded<SDKUserMessage>()
        const abort = new AbortController()
        const resume = input.resumeSessionId ?? lastSessionIds.get(input.threadId)
        const handle = yield* Effect.try({
          try: () =>
            query({
              prompt: Stream.toAsyncIterable(Stream.fromQueue(prompts)),
              options: {
                ...baseOptions(),
                cwd: input.cwd,
                model: input.model,
                ...(resume === undefined ? {} : { resume }),
                includePartialMessages: true,
                settingSources: ["user", "project", "local"],
                systemPrompt: { type: "preset", preset: "claude_code" },
                permissionMode: "default",
                thinking: { type: "adaptive", display: "summarized" },
                // Only invoked after the first prompt, by which time `session` is assigned.
                canUseTool: (toolName, toolInput, options) => askApproval(session, toolName, toolInput, options),
                mcpServers: { kkcode: { type: "http", url: input.mcpServerUrl } },
                abortController: abort,
              },
            }),
          catch: agentError("Failed to start Claude Code"),
        })
        const session: Session = {
          threadId: input.threadId,
          cwd: input.cwd,
          mcpServerUrl: input.mcpServerUrl,
          model: input.model,
          prompts,
          abort,
          query: handle,
          sessionAllowedTools: new Set(),
          pendingEdits: new Map(),
          sessionId: resume ?? null,
          turn: null,
          interrupted: false,
          pendingSteers: 0,
          abandonedTurns: 0,
        }
        sessions.set(input.threadId, session)
        yield* Effect.forkIn(pump(session), layerScope)
        return session
      })

    const acquireSession = (input: RunTurnInput) =>
      Effect.gen(function* () {
        const existing = sessions.get(input.threadId)
        if (existing !== undefined) {
          if (existing.cwd === input.cwd && existing.mcpServerUrl === input.mcpServerUrl) {
            return existing
          }
          yield* closeSession(existing)
        }
        return yield* startSession(input)
      })

    const interruptQuery = (session: Session) =>
      Effect.suspend(() => {
        session.interrupted = true
        return Effect.promise(() => session.query.interrupt()).pipe(Effect.ignore)
      })

    const runTurn = (input: RunTurnInput) =>
      Stream.callback<AgentEvent, AgentError>((turn) =>
        Effect.gen(function* () {
          const session = yield* acquireSession(input)
          if (session.turn !== null) {
            return yield* new AgentError({
              provider: "claude",
              message: "A turn is already running on this thread",
            })
          }
          if (session.model !== input.model) {
            yield* Effect.tryPromise({
              try: () => session.query.setModel(input.model),
              catch: agentError("Failed to switch model"),
            })
            session.model = input.model
          }
          session.turn = turn
          session.interrupted = false
          session.pendingSteers = 0
          // A consumer that stops reading mid-turn means the turn should stop too.
          yield* Effect.addFinalizer(() =>
            session.turn === turn
              ? Effect.sync(() => {
                  session.turn = null
                  session.abandonedTurns++
                }).pipe(Effect.andThen(interruptQuery(session)))
              : Effect.void,
          )
          yield* Queue.offer(session.prompts, yield* userMessage(input.prompt, input.attachments))
        }),
      )

    const steer = (threadId: string, text: string, attachments: ReadonlyArray<Attachment>) =>
      Effect.gen(function* () {
        const message = yield* userMessage(text, attachments, "now")
        const session = sessions.get(threadId)
        if (session?.turn == null) {
          return yield* new AgentError({ provider: "claude", message: "No turn is running on this thread" })
        }
        session.pendingSteers++
        yield* Queue.offer(session.prompts, message)
      })

    const fetchModels = Effect.gen(function* () {
      const prompts = yield* Queue.unbounded<SDKUserMessage>()
      const probe = query({
        prompt: Stream.toAsyncIterable(Stream.fromQueue(prompts)),
        options: { ...baseOptions(), settingSources: [], persistSession: false },
      })
      const models = yield* Effect.tryPromise({
        try: () => probe.supportedModels(),
        catch: agentError("Failed to list Claude models"),
      }).pipe(Effect.timeout(Duration.seconds(30)), Effect.ensuring(Effect.sync(() => probe.close())))
      const byId = new Map<string, ModelInfo>()
      for (const model of models) {
        if (model.value === "default") continue
        const id = model.resolvedModel ?? model.value
        if (!byId.has(id)) byId.set(id, { id, label: model.displayName, provider: "claude" })
      }
      return [...byId.values()]
    }).pipe(Effect.orElseSucceed(() => FALLBACK_MODELS))

    const listModels = yield* Effect.cachedWithTTL(fetchModels, Duration.minutes(10))

    yield* Effect.addFinalizer(() => Effect.forEach([...sessions.values()], closeSession, { discard: true }))

    return ClaudeProvider.of({
      id: "claude",
      listModels,
      runTurn,
      steer,
      interrupt: (threadId) => {
        const session = sessions.get(threadId)
        return session === undefined ? Effect.void : interruptQuery(session)
      },
      respondApproval: (requestId, decision) =>
        Effect.suspend(() => {
          const pending = approvals.get(requestId)
          if (pending === undefined) return Effect.void
          if (decision === "allow_for_session") pending.session.sessionAllowedTools.add(pending.toolName)
          return Deferred.succeed(pending.deferred, decision)
        }),
    })
  }),
)
