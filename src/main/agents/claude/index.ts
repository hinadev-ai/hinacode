import { execFileSync, spawn } from "node:child_process"
import { readFile } from "node:fs/promises"
import { createRequire } from "node:module"
import {
  type AccountInfo,
  type EffortLevel,
  type PermissionMode,
  query,
  type Options,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
  type SlashCommand,
} from "@anthropic-ai/claude-agent-sdk"
import { Cache, Cause, Context, Duration, Effect, Fiber, Layer, Queue, Schema, Stream } from "effect"
import type {
  AccountHome,
  AgentAccount,
  AgentCommand,
  AgentEvent,
  ModelInfo,
  RunTurnInput,
} from "../../../shared/agent.ts"
import type { AccessMode, Attachment } from "../../../shared/domain.ts"
import { nowIso } from "../../services/clock.ts"
import { registerAgentPid } from "../../services/Ports.ts"
import { resolveBinaryOnce } from "../binary.ts"
import { AgentError, type AgentProvider } from "../provider.ts"
import { perHome } from "../usage.ts"
import { permissionMode } from "./access.ts"
import { type ApprovalSession, makeApprovals } from "./approvals.ts"
import { isTerminal, mapMessage, resetTurnLimits, type MapState } from "./mapMessage.ts"
import { toPlanLimits } from "./limits.ts"
import { kkcodeMcpServer } from "./mcp.ts"
import { elementContext } from "../elementContext.ts"
import { makeQuestions, QUESTION_TOOL } from "./questions.ts"
import { claudeHome, makeTranscriptUsage } from "./transcripts.ts"

export class ClaudeProvider extends Context.Service<ClaudeProvider, AgentProvider>()("kkcode/agents/ClaudeProvider") {}

const fallbackModel = (id: string, label: string): ModelInfo => ({
  id,
  label,
  provider: "claude",
  efforts: [],
  defaultEffort: null,
  fastMode: false,
  autoMode: false,
})

const FALLBACK_MODELS: ReadonlyArray<ModelInfo> = [
  fallbackModel("claude-opus-5-5", "Opus 5.5"),
  fallbackModel("claude-fable-5-1", "Fable 5.1"),
  fallbackModel("claude-sonnet-5-5", "Sonnet 5.5"),
  fallbackModel("claude-haiku-5-5", "Haiku 5.5"),
]

const EFFORT_LEVELS: ReadonlyArray<string> = ["low", "medium", "high", "xhigh", "max"]
const isEffortLevel = (effort: string | null): effort is EffortLevel =>
  effort !== null && EFFORT_LEVELS.includes(effort)

const toCommand = (command: SlashCommand): AgentCommand => ({
  trigger: "/",
  name: command.name,
  description: command.description,
  argumentHint: command.argumentHint,
})

type TurnQueue = Queue.Queue<AgentEvent, AgentError | Cause.Done>

const IDLE_SESSION_TTL = Duration.seconds(60)

interface Session extends MapState, ApprovalSession {
  readonly threadId: string
  readonly cwd: string
  readonly home: AccountHome | null
  readonly instructions: string
  readonly prompts: Queue.Queue<SDKUserMessage>
  readonly abort: AbortController
  readonly query: Query
  model: string
  effort: string | null
  fastMode: boolean
  permissionMode: PermissionMode
  sessionId: string | null
  turn: TurnQueue | null
  interrupted: boolean
  /** Steer prompts sent during the current turn; each makes the CLI end its in-flight response with an aborted result. */
  pendingSteers: number
  /** Turns whose consumer left before their result; their remaining messages must not reach the next turn. */
  abandonedTurns: number
  readonly tasks: Map<string, string | undefined>
  taskSnapshots: boolean
  claims: number
  expiry: Fiber.Fiber<void> | null
  closed: boolean
}

const isIdle = (session: Session) =>
  session.turn === null && session.claims === 0 && session.abandonedTurns === 0 && session.tasks.size === 0

interface SessionContext {
  readonly cwd: string
  readonly home: AccountHome | null
  readonly instructions: string
}

interface Resumable extends SessionContext {
  readonly sessionId: string
  readonly sessionGrants: Set<string>
  readonly attachmentPaths: Set<string>
}

const externalServices: Record<Exclude<NonNullable<AccountInfo["apiProvider"]>, "firstParty">, string> = {
  bedrock: "Amazon Bedrock",
  vertex: "Google Vertex AI",
  foundry: "Microsoft Foundry",
  anthropicAws: "Claude Platform on AWS",
  anthropicGoogleCloud: "Claude Platform on Google Cloud",
  mantle: "Mantle",
  gateway: "an enterprise gateway",
}

const AccountInfoSchema = Schema.Struct({
  email: Schema.optionalKey(Schema.String),
  organization: Schema.optionalKey(Schema.String),
  subscriptionType: Schema.optionalKey(Schema.String),
  apiKeySource: Schema.optionalKey(Schema.String),
  apiProvider: Schema.optionalKey(
    Schema.Literals([
      "firstParty",
      "bedrock",
      "vertex",
      "foundry",
      "anthropicAws",
      "anthropicGoogleCloud",
      "mantle",
      "gateway",
    ]),
  ),
})

const toAccount = (info: AccountInfo): AgentAccount => {
  if (info.apiProvider !== undefined && info.apiProvider !== "firstParty") {
    return { type: "external", service: externalServices[info.apiProvider] }
  }
  if (info.email !== undefined || info.subscriptionType !== undefined) {
    return {
      type: "subscription",
      email: info.email ?? null,
      plan: info.subscriptionType ?? null,
      organization: info.organization ?? null,
    }
  }
  return info.apiKeySource === undefined ? { type: "signedOut" } : { type: "apiKey" }
}

const commandsKey = (cwd: string, home: AccountHome | null) => JSON.stringify({ cwd, home })

const sameHome = (a: AccountHome | null, b: AccountHome | null) => a?.dir === b?.dir && a?.binary === b?.binary

const sameContext = (a: SessionContext, b: SessionContext) =>
  a.cwd === b.cwd && sameHome(a.home, b.home) && a.instructions === b.instructions

/** The CLI's env for an account: its own home, or the user's default one for null. */
const homeEnv = (home: AccountHome | null): NodeJS.ProcessEnv =>
  home === null ? { ...process.env } : { ...process.env, CLAUDE_CONFIG_DIR: home.dir }

const agentError = (message: string) => (cause: unknown) =>
  new AgentError({
    provider: "claude",
    message: `${message}: ${cause instanceof Error ? cause.message : String(cause)}`,
  })

/**
 * GUI-launched Electron apps (notably on macOS) get a minimal PATH, so fall back to a login shell
 * to find the user's `claude` install.
 */
export function resolveClaudeExecutable(): string | undefined {
  const attempts: Array<[string, Array<string>]> = [
    ["which", ["claude"]],
    [process.env.SHELL ?? "/bin/sh", ["-lc", "command -v claude"]],
  ]
  for (const [command, args] of attempts) {
    try {
      const path = execFileSync(command, args, { encoding: "utf8", timeout: 5000 }).trim()
      if (path !== "") return path
    } catch {}
  }
  return bundledClaudeExecutable()
}

/** The SDK finds its bundled binary inside app.asar, where it cannot be spawned, so point it at the unpacked copy. */
function bundledClaudeExecutable(): string | undefined {
  try {
    const sdk = createRequire(import.meta.url).resolve("@anthropic-ai/claude-agent-sdk")
    return createRequire(sdk)
      .resolve(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/claude`)
      .replace("app.asar", "app.asar.unpacked")
  } catch {
    return undefined
  }
}

/** The Messages API rejects base64 images above 5 MB. */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024

type ContentBlock = Exclude<SDKUserMessage["message"]["content"], string>[number]
type ImageMediaType = Extract<Extract<ContentBlock, { type: "image" }>["source"], { type: "base64" }>["media_type"]

const IMAGE_MEDIA_TYPES: ReadonlyArray<string> = ["image/png", "image/jpeg", "image/gif", "image/webp"]
const isImageMediaType = (mime: string): mime is ImageMediaType => IMAGE_MEDIA_TYPES.includes(mime)

/**
 * Images go inline as base64, followed by what the user picked when the image is a browser element. Other files
 * are named by path so the agent reads them with its own tools.
 */
const attachmentBlocks = (attachment: Attachment) =>
  Effect.gen(function* () {
    const fileBlock: ContentBlock = { type: "text", text: `Attached file: ${attachment.path}` }
    if (attachment.kind !== "image" || !isImageMediaType(attachment.mime)) return [fileBlock]
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
    return attachment.element ? [block, { type: "text" as const, text: elementContext(attachment.element) }] : [block]
  })

const userMessage = (prompt: string, attachments: ReadonlyArray<Attachment>, priority?: SDKUserMessage["priority"]) =>
  Effect.gen(function* () {
    const blocks = (yield* Effect.forEach(attachments, attachmentBlocks)).flat()
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
    const resumable = new Map<string, Resumable>()

    const executableFor = (home: AccountHome | null) => (home === null ? executable : resolveBinaryOnce(home.binary))

    const baseOptions = (home: AccountHome | null): Options => {
      const path = executableFor(home)
      return {
        // The SDK replaces the child env instead of merging it.
        env: homeEnv(home),
        ...(path === undefined ? {} : { pathToClaudeCodeExecutable: path }),
      }
    }

    const emit = (session: Session, event: AgentEvent) => {
      if (session.turn === null) return
      if ((event.type === "turn_failed" || event.type === "turn_limited") && session.interrupted)
        event = { type: "turn_failed", message: "Interrupted" }
      Queue.offerUnsafe(session.turn, event)
      if (isTerminal(event)) {
        Queue.endUnsafe(session.turn)
        session.turn = null
      }
    }

    const approvals = makeApprovals(emit)
    const questions = makeQuestions(emit)

    const cancelExpiry = (session: Session) => {
      session.expiry?.interruptUnsafe()
      session.expiry = null
    }

    const closeSessionUnsafe = (session: Session) => {
      if (session.closed) return
      session.closed = true
      cancelExpiry(session)
      if (sessions.get(session.threadId) === session) sessions.delete(session.threadId)
      Queue.shutdownUnsafe(session.prompts)
      session.abort.abort()
      session.query.close()
    }

    const closeSession = (session: Session) => Effect.sync(() => closeSessionUnsafe(session))

    const armExpiry = (session: Session) =>
      Effect.suspend(() => {
        if (session.closed) return Effect.void
        if (!isIdle(session)) {
          cancelExpiry(session)
          return Effect.void
        }
        if (session.expiry !== null) return Effect.void
        const expire = Effect.sleep(IDLE_SESSION_TTL).pipe(
          Effect.andThen(
            Effect.sync(() => {
              session.expiry = null
              if (isIdle(session)) closeSessionUnsafe(session)
            }),
          ),
        )
        return Effect.map(Effect.forkIn(expire, layerScope), (fiber) => {
          session.expiry = fiber
        })
      })

    const claim = (session: Session) => {
      session.claims++
      cancelExpiry(session)
      return session
    }

    const release = (session: Session) =>
      Effect.suspend(() => {
        session.claims--
        return armExpiry(session)
      })

    const lease = <A, E>(session: Session, use: (session: Session) => Effect.Effect<A, E>) =>
      Effect.acquireUseRelease(
        Effect.sync(() => claim(session)),
        use,
        release,
      )

    /** A run id that sorts before the task's current one belongs to an earlier run of a resumed task. */
    const isLateRun = (session: Session, taskId: string, runId: string | undefined) => {
      const current = session.tasks.get(taskId)
      return runId !== undefined && current !== undefined && runId < current
    }

    const trackTask = (session: Session, message: SDKMessage) => {
      if (message.type !== "system") return
      if (message.subtype === "background_tasks_changed") {
        session.taskSnapshots = true
        session.tasks.clear()
        for (const task of message.tasks) if (task.ambient !== true) session.tasks.set(task.task_id, task.run_id)
        return
      }
      // CLIs that predate snapshots only send these edges, and the SDK says not to correlate the two streams.
      if (session.taskSnapshots) return
      switch (message.subtype) {
        case "task_started":
          if (
            message.ambient !== true &&
            message.is_backgrounded !== false &&
            !isLateRun(session, message.task_id, message.run_id)
          )
            session.tasks.set(message.task_id, message.run_id)
          return
        case "task_updated": {
          if (isLateRun(session, message.task_id, message.run_id)) return
          const { status, is_backgrounded } = message.patch
          if (status === "completed" || status === "failed" || status === "killed")
            session.tasks.delete(message.task_id)
          else if (is_backgrounded === true) session.tasks.set(message.task_id, message.run_id)
          return
        }
        case "task_notification":
          if (!isLateRun(session, message.task_id, message.run_id)) session.tasks.delete(message.task_id)
          return
      }
    }

    const route = (session: Session, message: SDKMessage) => {
      trackTask(session, message)
      // The CLI handles prompts in order, so everything up to an abandoned turn's result is stale.
      if (session.abandonedTurns > 0) {
        if (message.type === "result") {
          session.abandonedTurns--
          resetTurnLimits(session)
        }
        return
      }
      if (session.pendingSteers > 0 && !session.interrupted && isSteerAbort(message)) {
        session.pendingSteers--
        resetTurnLimits(session)
        return
      }
      if (message.type === "result") session.pendingSteers = 0
      if (message.type === "system" && message.subtype === "init") {
        session.sessionId = message.session_id
        resumable.set(session.threadId, {
          cwd: session.cwd,
          home: session.home,
          instructions: session.instructions,
          sessionId: message.session_id,
          sessionGrants: session.sessionGrants,
          attachmentPaths: session.attachmentPaths,
        })
      }
      for (const event of mapMessage(message, session, new Date().toISOString())) emit(session, event)
    }

    /** Reads every SDK message of the session for its lifetime and routes it to the active turn. */
    const pump = (session: Session) =>
      Stream.fromAsyncIterable(
        // Iterate the Query itself: its return() closes the transport, the raw generator's does not.
        { [Symbol.asyncIterator]: () => session.query },
        agentError("Claude Code stream failed"),
      ).pipe(
        Stream.runForEach((message) =>
          Effect.sync(() => route(session, message)).pipe(Effect.andThen(armExpiry(session))),
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

    const permissionModeFor = (accessMode: AccessMode, model: string) =>
      accessMode === "auto"
        ? Effect.map(listModels, (models) =>
            permissionMode(
              accessMode,
              models.some((listed) => listed.id === model && listed.autoMode),
            ),
          )
        : Effect.succeed(permissionMode(accessMode, false))

    const startSession = (input: RunTurnInput, mode: PermissionMode) =>
      Effect.gen(function* () {
        const prompts = yield* Queue.unbounded<SDKUserMessage>()
        const abort = new AbortController()
        const previous = resumable.get(input.threadId)
        const resume = input.resumeSessionId ?? previous?.sessionId
        const keepsGrants = previous !== undefined && previous.sessionId === resume && sameContext(previous, input)
        const handle = yield* Effect.try({
          try: () =>
            query({
              prompt: Stream.toAsyncIterable(Stream.fromQueue(prompts)),
              options: {
                ...baseOptions(input.home),
                cwd: input.cwd,
                model: input.model,
                ...(isEffortLevel(input.effort) ? { effort: input.effort } : {}),
                settings: { fastMode: input.fastMode },
                ...(resume === undefined ? {} : { resume }),
                includePartialMessages: true,
                settingSources: ["user", "project", "local"],
                systemPrompt: { type: "preset", preset: "claude_code", append: input.instructions },
                permissionMode: mode,
                // Lets a live session switch to full access; the mode above decides what runs unasked.
                allowDangerouslySkipPermissions: true,
                thinking: { type: "adaptive", display: "summarized" },
                // One-line "what it is doing now" for each sub-agent in the Agents tab.
                agentProgressSummaries: true,
                // Only invoked after the first prompt, by which time `session` is assigned.
                canUseTool: (toolName, toolInput, options) =>
                  toolName === QUESTION_TOOL
                    ? questions.ask(session, toolInput, options)
                    : approvals.ask(session, toolName, toolInput, options),
                mcpServers: { kkcode: kkcodeMcpServer(input.mcpServer) },
                abortController: abort,
                // Same as the SDK's default spawn, plus the pid so the thread's open ports can be found.
                // The SDK does not read stderr from a custom spawn, so it is not piped (an unread pipe
                // would eventually block the CLI).
                spawnClaudeCodeProcess: ({ command, args, cwd, env, signal }) => {
                  const child = spawn(command, args, { cwd, env, signal, stdio: ["pipe", "pipe", "ignore"] })
                  if (child.pid !== undefined) child.once("exit", registerAgentPid(input.threadId, child.pid))
                  return child
                },
              },
            }),
          catch: agentError("Failed to start Claude Code"),
        })
        const session: Session = {
          threadId: input.threadId,
          cwd: input.cwd,
          home: input.home,
          instructions: input.instructions,
          model: input.model,
          effort: input.effort,
          fastMode: input.fastMode,
          permissionMode: mode,
          prompts,
          abort,
          query: handle,
          sessionGrants: keepsGrants ? previous.sessionGrants : new Set(),
          attachmentPaths: keepsGrants ? previous.attachmentPaths : new Set(),
          pendingEdits: new Map(),
          limitMessage: null,
          limitResetAt: null,
          subagents: new Map(),
          lastRequest: null,
          sessionId: resume ?? null,
          turn: null,
          interrupted: false,
          pendingSteers: 0,
          abandonedTurns: 0,
          tasks: new Map(),
          taskSnapshots: false,
          claims: 1,
          expiry: null,
          closed: false,
        }
        sessions.set(input.threadId, session)
        yield* Effect.forkIn(pump(session), layerScope)
        return session
      })

    const acquireSession = (input: RunTurnInput, mode: PermissionMode) =>
      Effect.gen(function* () {
        const existing = sessions.get(input.threadId)
        if (existing !== undefined) {
          if (sameContext(existing, input)) return claim(existing)
          yield* closeSession(existing)
        }
        return yield* startSession(input, mode)
      })

    const interruptQuery = (session: Session) =>
      Effect.suspend(() => {
        session.interrupted = true
        return Effect.promise(() => session.query.interrupt()).pipe(Effect.ignore)
      })

    const switchPermissionMode = (session: Session, mode: PermissionMode) =>
      Effect.gen(function* () {
        if (mode === session.permissionMode) return
        yield* Effect.tryPromise({
          try: () => session.query.setPermissionMode(mode),
          catch: agentError("Failed to switch access mode"),
        })
        session.permissionMode = mode
      })

    const startTurn = (session: Session, input: RunTurnInput, mode: PermissionMode, turn: TurnQueue) =>
      Effect.gen(function* () {
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
        if (session.effort !== input.effort || session.fastMode !== input.fastMode) {
          yield* Effect.tryPromise({
            try: () =>
              session.query.applyFlagSettings({
                effortLevel: isEffortLevel(input.effort) ? input.effort : null,
                fastMode: input.fastMode,
              }),
            catch: agentError("Failed to switch effort or fast mode"),
          })
          session.effort = input.effort
          session.fastMode = input.fastMode
        }
        yield* switchPermissionMode(session, mode)
        const message = yield* userMessage(input.prompt, input.attachments)
        session.turn = turn
        resetTurnLimits(session)
        session.interrupted = false
        session.pendingSteers = 0
        session.lastRequest = null
        // A consumer that stops reading mid-turn means the turn should stop too.
        yield* Effect.addFinalizer(() =>
          session.turn === turn
            ? Effect.sync(() => {
                session.turn = null
                session.abandonedTurns++
              }).pipe(Effect.andThen(interruptQuery(session)))
            : Effect.void,
        )
        for (const attachment of input.attachments) session.attachmentPaths.add(attachment.path)
        yield* Queue.offer(session.prompts, message)
      })

    const runTurn = (input: RunTurnInput) =>
      Stream.callback<AgentEvent, AgentError>((turn) =>
        Effect.flatMap(permissionModeFor(input.accessMode, input.model), (mode) =>
          Effect.acquireUseRelease(
            acquireSession(input, mode),
            (session) => startTurn(session, input, mode, turn),
            release,
          ),
        ),
      )

    const steer = (threadId: string, text: string, attachments: ReadonlyArray<Attachment>) =>
      Effect.gen(function* () {
        const message = yield* userMessage(text, attachments, "now")
        const session = sessions.get(threadId)
        if (session?.turn == null) {
          return yield* new AgentError({ provider: "claude", message: "No turn is running on this thread" })
        }
        session.pendingSteers++
        for (const attachment of attachments) session.attachmentPaths.add(attachment.path)
        yield* Queue.offer(session.prompts, message)
      })

    /** Asks a throwaway CLI one question, then closes it. It loads no settings unless `options` asks for them. */
    const probe = <A>(
      read: (probe: Query) => Promise<A>,
      failure: string,
      home: AccountHome | null,
      options: Options = {},
    ) =>
      Effect.gen(function* () {
        const prompts = yield* Queue.unbounded<SDKUserMessage>()
        const cli = query({
          prompt: Stream.toAsyncIterable(Stream.fromQueue(prompts)),
          options: { ...baseOptions(home), settingSources: [], persistSession: false, ...options },
        })
        return yield* Effect.tryPromise({ try: () => read(cli), catch: agentError(failure) }).pipe(
          Effect.timeout(Duration.seconds(30)),
          Effect.catchTag("TimeoutError", () =>
            Effect.fail(new AgentError({ provider: "claude", message: `${failure}: timed out` })),
          ),
          Effect.ensuring(Effect.sync(() => cli.close())),
        )
      })

    const fetchModels = Effect.gen(function* () {
      const models = yield* probe((cli) => cli.supportedModels(), "Failed to list Claude models", null)
      const byId = new Map<string, ModelInfo>()
      for (const model of models) {
        if (model.value === "default") continue
        const id = model.resolvedModel ?? model.value
        if (byId.has(id)) continue
        byId.set(id, {
          id,
          label: model.displayName,
          provider: "claude",
          efforts: model.supportsEffort ? (model.supportedEffortLevels ?? []) : [],
          defaultEffort: null,
          fastMode: model.supportsFastMode ?? false,
          autoMode: model.supportsAutoMode ?? false,
        })
      }
      return [...byId.values()]
    }).pipe(Effect.orElseSucceed(() => FALLBACK_MODELS))

    const listModels = yield* Effect.cachedWithTTL(fetchModels, Duration.minutes(10))

    /**
     * A throwaway CLI in `cwd` that loads the same settings, skills and plugins a thread there would. Keyed
     * by `commandsKey`, since the account's home holds the user-level ones.
     */
    const probeCommands = (key: string) => {
      const { cwd, home } = JSON.parse(key) as { cwd: string; home: AccountHome | null }
      return probe((cli) => cli.supportedCommands(), "Failed to list Claude commands", home, {
        cwd,
        settingSources: ["user", "project", "local"],
      })
    }
    const account = (home: AccountHome | null) =>
      probe((cli) => cli.accountInfo(), "Failed to read the Claude account", home).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(AccountInfoSchema)),
        Effect.catchTag("SchemaError", () =>
          Effect.fail(
            new AgentError({ provider: "claude", message: "Failed to read the Claude account: invalid response" }),
          ),
        ),
        Effect.map(toAccount),
      )
    const planLimits = (home: AccountHome | null) =>
      probe(
        (cli) => cli.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }),
        "Failed to read Claude plan limits",
        home,
      ).pipe(
        Effect.flatMap((raw) => Effect.map(nowIso, (readAt) => toPlanLimits(raw, readAt))),
        Effect.orElseSucceed(() => null),
      )

    const transcriptUsage = perHome(makeTranscriptUsage)
    const usage = (sessionId: string, home: AccountHome | null) =>
      Effect.tryPromise({
        try: () => transcriptUsage(home?.dir ?? claudeHome())(sessionId),
        catch: agentError("Failed to read Claude transcripts"),
      })

    const probedCommands = yield* Cache.make({
      lookup: probeCommands,
      capacity: 32,
      timeToLive: Duration.minutes(1),
    })

    const listCommands = ({
      threadId,
      cwd,
      home,
    }: {
      readonly threadId: string
      readonly cwd: string
      readonly home: AccountHome | null
    }) =>
      Effect.suspend(() => {
        const session = sessions.get(threadId)
        return session !== undefined && session.cwd === cwd && sameHome(session.home, home)
          ? lease(session, (leased) =>
              Effect.tryPromise({
                try: () => leased.query.supportedCommands(),
                catch: agentError("Failed to list Claude commands"),
              }),
            )
          : Cache.get(probedCommands, commandsKey(cwd, home))
      }).pipe(Effect.map((commands) => commands.map(toCommand)))

    yield* Effect.addFinalizer(() => Effect.forEach([...sessions.values()], closeSession, { discard: true }))

    return ClaudeProvider.of({
      id: "claude",
      listModels,
      account,
      planLimits,
      usage,
      listCommands,
      runTurn,
      steer,
      interrupt: (threadId) => {
        const session = sessions.get(threadId)
        return session === undefined ? Effect.void : interruptQuery(session)
      },
      respondApproval: approvals.respond,
      respondQuestion: questions.respond,
      setAccessMode: (threadId, accessMode) =>
        Effect.gen(function* () {
          const session = sessions.get(threadId)
          if (session === undefined) return
          const mode = yield* permissionModeFor(accessMode, session.model)
          if (session.closed) return
          yield* lease(session, (leased) => switchPermissionMode(leased, mode))
        }),
    })
  }),
)
