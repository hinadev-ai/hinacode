import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { readFile } from "node:fs/promises"
import {
  type AccountInfo,
  type EffortLevel,
  type PermissionMode,
  query,
  type Options,
  type Query,
  type SDKControlGetContextUsageResponse,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk"
import { Cache, Cause, Clock, Context, Duration, Effect, Exit, Fiber, Layer, Queue, Schema, Stream } from "effect"
import {
  type AccountHome,
  type AgentAccount,
  type AgentEvent,
  type BackgroundTask,
  CLAUDE_EFFORT_LEVELS,
  type ContextBreakdown,
  type ModelInfo,
  type RunTurnInput,
} from "../../../shared/agent.ts"
import type { AccessMode, Attachment } from "../../../shared/domain.ts"
import { nowIso } from "../../services/clock.ts"
import { registerAgentPid } from "../../services/Ports.ts"
import { installedBinary } from "../binary.ts"
import { AgentError, type AgentProvider, type BackgroundTasksChange, type Wake } from "../provider.ts"
import { perHome } from "../usage.ts"
import { permissionMode } from "./access.ts"
import { type ApprovalSession, makeApprovals } from "./approvals.ts"
import { hideUserCommands, toCommand } from "./commands.ts"
import {
  backgroundTasksOf,
  isTerminal,
  mapMessage,
  resetTurnLimits,
  wakeupCallOf,
  wakeupOf,
  type MapState,
  type WakeupCall,
} from "./mapMessage.ts"
import { toPlanLimits } from "./limits.ts"
import { hinacodeMcpServer } from "./mcp.ts"
import { attachmentContext } from "../elementContext.ts"
import { makeQuestions, QUESTION_TOOL } from "./questions.ts"
import { claudeHome, copyTranscripts, makeTranscriptUsage } from "./transcripts.ts"

export class ClaudeProvider extends Context.Service<ClaudeProvider, AgentProvider>()(
  "hinacode/agents/ClaudeProvider",
) {}

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

const isEffortLevel = (effort: string | null): effort is EffortLevel =>
  effort !== null && CLAUDE_EFFORT_LEVELS.includes(effort)

/**
 * Claude Code modes offered beside the effort levels. Ultrathink is a prompt keyword that asks for deeper
 * reasoning on the turn at the model's default effort. Ultracode has Claude orchestrate dynamic workflows, and
 * runs at extra high effort like `claude --effort ultracode`; a model without extra high cannot run it.
 */
const ULTRATHINK = "ultrathink"
const ULTRACODE = "ultracode"

const effortLevelOf = (effort: string | null): EffortLevel | null =>
  effort === ULTRACODE ? "xhigh" : isEffortLevel(effort) ? effort : null

const withUltrathink = (prompt: string, effort: string | null) =>
  effort === ULTRATHINK ? `${prompt}\n\n${ULTRATHINK}`.trimStart() : prompt

const effortsOf = (levels: ReadonlyArray<string>) =>
  levels.length === 0 ? [] : [...levels, ULTRATHINK, ...(levels.includes("xhigh") ? [ULTRACODE] : [])]

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
  readonly userSkills: boolean
  readonly autoCompactTokens: number | null
  permissionMode: PermissionMode
  sessionId: string | null
  /** Uuid of the latest assistant message in the session's own chain, where a fork keeps the turn it ends. */
  lastAssistantUuid: string | null
  turn: TurnQueue | null
  interrupted: boolean
  /** Uuids of the prompts sent during the current turn: the first one and every steer. */
  readonly turnPrompts: Set<string>
  /** Uuids of the prompts sent in any turn that no result has answered yet. */
  readonly unanswered: Set<string>
  /** Uuids of the prompts the CLI's current response answers, as stamped on its first message. */
  answering: ReadonlyArray<string>
  readonly tasks: Map<string, string | undefined>
  taskSnapshots: boolean
  /** What the latest snapshot showed as background tasks. Only CLIs that send snapshots fill it. */
  backgroundTasks: ReadonlyArray<BackgroundTask>
  /** The `ScheduleWakeup` call whose result has not arrived yet. */
  wakeupCall: WakeupCall | null
  /** The turn the agent scheduled for later. The CLI fires it only while its process lives. */
  wakeup: BackgroundTask | null
  /** The CLI sends `session_state_changed`, so a turn ends when it goes idle instead of at its result. */
  reportsState: boolean
  /** The event that ends the turn once the CLI goes idle, mapped from the turn's latest result. */
  heldEnd: AgentEvent | null
  claims: number
  expiry: Fiber.Fiber<void> | null
  closed: boolean
}

/** Deferred tools sit outside the window until the agent loads one, so they are left out. */
const toContextBreakdown = (usage: SDKControlGetContextUsageResponse): ContextBreakdown => ({
  usedTokens: usage.totalTokens,
  maxTokens: usage.rawMaxTokens,
  categories: usage.categories.flatMap(({ name, tokens, kind }) =>
    kind === "deferred" || tokens === 0 ? [] : [{ name, tokens, kind }],
  ),
})

const isIdle = (session: Session) =>
  session.turn === null && session.claims === 0 && session.unanswered.size === 0 && session.tasks.size === 0

/** The CLI reports it is working while no turn is open: it started on its own, not on a prompt. */
const startsByItself = (session: Session, message: SDKMessage) =>
  message.type === "system" &&
  message.subtype === "session_state_changed" &&
  message.state === "running" &&
  session.turn === null

/** A steer of the current turn the CLI has not answered yet, which will get its own result. */
const awaitsAnswer = (session: Session) => [...session.turnPrompts].some((uuid) => session.unanswered.has(uuid))

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

const copySession = (sessionId: string, from: AccountHome | null, to: AccountHome | null) =>
  Effect.tryPromise({
    try: () => copyTranscripts(sessionId, from?.dir ?? claudeHome(), to?.dir ?? claudeHome()),
    catch: agentError("Failed to copy Claude transcripts"),
  }).pipe(
    Effect.flatMap((copied) =>
      copied
        ? Effect.void
        : Effect.fail(
            new AgentError({
              provider: "claude",
              message: "No Claude transcript for this session in the old account",
            }),
          ),
    ),
  )

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
    const context = attachmentContext(attachment)
    return context === null ? [block] : [block, { type: "text" as const, text: context }]
  })

const userMessage = (prompt: string, attachments: ReadonlyArray<Attachment>, priority?: SDKUserMessage["priority"]) =>
  Effect.gen(function* () {
    const blocks = (yield* Effect.forEach(attachments, attachmentBlocks)).flat()
    const content: SDKUserMessage["message"]["content"] =
      blocks.length === 0 ? prompt : [...(prompt === "" ? [] : [{ type: "text" as const, text: prompt }]), ...blocks]
    return {
      type: "user",
      uuid: randomUUID(),
      message: { role: "user", content },
      parent_tool_use_id: null,
      ...(priority === undefined ? {} : { priority }),
    } satisfies SDKUserMessage
  })

/** The prompts a response answers. The CLI stamps them on the response's first message and on its result. */
const answeredPrompts = (message: SDKMessage) => {
  if (message.type !== "stream_event" && message.type !== "assistant" && message.type !== "result") return undefined
  return (
    message.user_message_uuids ?? (message.user_message_uuid === undefined ? undefined : [message.user_message_uuid])
  )
}

const baseOptions = (home: AccountHome | null) =>
  Effect.map(installedBinary("claude", home?.binary ?? "claude"), (path): Options => ({
    // The SDK replaces the child env instead of merging it.
    env: homeEnv(home),
    pathToClaudeCodeExecutable: path,
  }))

/** Asks a throwaway CLI one question, then closes it. It loads no settings unless `options` asks for them. */
const probe = <A>(
  read: (probe: Query) => Promise<A>,
  failure: string,
  home: AccountHome | null,
  options: Options = {},
) =>
  Effect.gen(function* () {
    const prompts = yield* Queue.unbounded<SDKUserMessage>()
    const base = yield* baseOptions(home)
    const cli = query({
      prompt: Stream.toAsyncIterable(Stream.fromQueue(prompts)),
      options: { ...base, settingSources: [], persistSession: false, ...options },
    })
    return yield* Effect.tryPromise({ try: () => read(cli), catch: agentError(failure) }).pipe(
      Effect.timeout(Duration.seconds(30)),
      Effect.catchTag("TimeoutError", () =>
        Effect.fail(new AgentError({ provider: "claude", message: `${failure}: timed out` })),
      ),
      Effect.ensuring(Effect.sync(() => cli.close())),
    )
  })

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

export const layer = Layer.effect(
  ClaudeProvider,
  Effect.gen(function* () {
    const layerScope = yield* Effect.scope
    const sessions = new Map<string, Session>()
    const resumable = new Map<string, Resumable>()
    const wakes = yield* Queue.unbounded<Wake>()
    const backgroundTaskChanges = yield* Queue.unbounded<BackgroundTasksChange>()
    const probedCommands = yield* Cache.make({
      lookup: probeCommands,
      capacity: 32,
      timeToLive: Duration.minutes(1),
    })

    const skillOverrides = (input: RunTurnInput) =>
      input.userSkills
        ? Effect.succeed(null)
        : Cache.get(probedCommands, commandsKey(input.cwd, input.home)).pipe(Effect.map(hideUserCommands))

    const emit = (session: Session, event: AgentEvent) => {
      if (session.turn === null) return
      if ((event.type === "turn_failed" || event.type === "turn_limited") && session.interrupted)
        event = { type: "turn_failed", message: "Interrupted" }
      if (event.type === "turn_completed" && session.sessionId !== null && session.lastAssistantUuid !== null)
        event = { ...event, forkPoint: { sessionId: session.sessionId, checkpoint: session.lastAssistantUuid } }
      Queue.offerUnsafe(session.turn, event)
      if (isTerminal(event)) {
        Queue.endUnsafe(session.turn)
        session.turn = null
        session.turnPrompts.clear()
        session.heldEnd = null
      }
    }

    const approvals = makeApprovals(emit)
    const questions = makeQuestions(emit)

    const cancelExpiry = (session: Session) => {
      session.expiry?.interruptUnsafe()
      session.expiry = null
    }

    const setBackgroundTasks = (
      session: Session,
      tasks: ReadonlyArray<BackgroundTask>,
      wakeup: BackgroundTask | null = session.wakeup,
    ) => {
      const hadTasks = session.backgroundTasks.length > 0 || session.wakeup !== null
      if (!hadTasks && tasks.length === 0 && wakeup === null) return
      session.backgroundTasks = tasks
      session.wakeup = wakeup
      Queue.offerUnsafe(backgroundTaskChanges, {
        threadId: session.threadId,
        tasks: wakeup === null ? tasks : [...tasks, wakeup],
      })
    }

    const closeSessionUnsafe = (session: Session) => {
      if (session.closed) return
      session.closed = true
      // The CLI's background shells and scheduled wakeups end with its process.
      setBackgroundTasks(session, [], null)
      cancelExpiry(session)
      if (sessions.get(session.threadId) === session) sessions.delete(session.threadId)
      Queue.shutdownUnsafe(session.prompts)
      session.abort.abort()
      session.query.close()
    }

    const closeSession = (session: Session) => Effect.sync(() => closeSessionUnsafe(session))

    const armExpiry = (session: Session) =>
      Effect.gen(function* () {
        if (session.closed) return
        const now = yield* Clock.currentTimeMillis
        const firesAt = session.wakeup?.firesAt
        const untilWakeup = firesAt === undefined ? 0 : Date.parse(firesAt) - now
        // A due wakeup has fired or is about to, and the idle grace covers a CLI that fires it late.
        if (firesAt !== undefined && untilWakeup <= 0) setBackgroundTasks(session, session.backgroundTasks, null)
        if (!isIdle(session)) {
          cancelExpiry(session)
          return
        }
        if (session.expiry !== null) return
        // The CLI fires a wakeup only while its process lives.
        const expire = Effect.sleep(Duration.sum(Duration.millis(Math.max(0, untilWakeup)), IDLE_SESSION_TTL)).pipe(
          Effect.andThen(
            Effect.sync(() => {
              session.expiry = null
              if (isIdle(session)) closeSessionUnsafe(session)
            }),
          ),
        )
        session.expiry = yield* Effect.forkIn(expire, layerScope)
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

    const trackWakeup = (session: Session, message: SDKMessage) => {
      const call = wakeupCallOf(message)
      if (call !== null) {
        session.wakeupCall = call
        return
      }
      if (session.wakeupCall === null) return
      const wakeup = wakeupOf(message, session.wakeupCall, new Date().toISOString())
      if (wakeup === undefined) return
      session.wakeupCall = null
      setBackgroundTasks(session, session.backgroundTasks, wakeup)
    }

    const trackTask = (session: Session, message: SDKMessage) => {
      trackWakeup(session, message)
      if (message.type !== "system") return
      if (message.subtype === "background_tasks_changed") {
        session.taskSnapshots = true
        session.tasks.clear()
        for (const task of message.tasks) if (task.ambient !== true) session.tasks.set(task.task_id, task.run_id)
        setBackgroundTasks(session, backgroundTasksOf(message, session.backgroundTasks, new Date().toISOString()))
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
      if (message.type === "system" && message.subtype === "session_state_changed") {
        session.reportsState = true
        // Unlike a result, idle waits for background sub-agents and for Claude's replies to their reports.
        if (message.state === "idle" && session.turn !== null && !awaitsAnswer(session))
          emit(session, session.heldEnd ?? { type: "turn_completed" })
        return
      }
      const answered = answeredPrompts(message)
      if (answered !== undefined) session.answering = answered
      // A response that answers only prompts of a turn whose consumer left before its result. The CLI can batch
      // such a steer with a steer of the current turn, and that response belongs to the current turn.
      const stale = session.answering.length > 0 && session.answering.every((uuid) => !session.turnPrompts.has(uuid))
      if (message.type === "result") {
        // CLIs that predate the stamps name no prompt; ending the turn beats waiting for a result that never comes.
        for (const uuid of answered ?? [...session.unanswered]) session.unanswered.delete(uuid)
        session.answering = []
        // A steer the CLI read too late to abort the response gets its own result after this one.
        if (stale || awaitsAnswer(session)) {
          resetTurnLimits(session)
          return
        }
      } else if (stale) return
      if (message.type === "assistant" && message.parent_tool_use_id === null) session.lastAssistantUuid = message.uuid
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
      for (const event of mapMessage(message, session, new Date().toISOString())) {
        if (isTerminal(event) && session.reportsState) session.heldEnd = event
        else emit(session, event)
      }
    }

    /** Reads every SDK message of the session for its lifetime and routes it to the active turn. */
    const pump = (session: Session) =>
      Stream.fromAsyncIterable(
        // Iterate the Query itself: its return() closes the transport, the raw generator's does not.
        { [Symbol.asyncIterator]: () => session.query },
        agentError("Claude Code stream failed"),
      ).pipe(
        Stream.runForEach((message) =>
          (startsByItself(session, message) ? wake(session) : Effect.sync(() => route(session, message))).pipe(
            Effect.andThen(armExpiry(session)),
          ),
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
        const base = yield* baseOptions(input.home)
        const hidden = yield* skillOverrides(input)
        const effort = effortLevelOf(input.effort)
        const handle = yield* Effect.try({
          try: () =>
            query({
              prompt: Stream.toAsyncIterable(Stream.fromQueue(prompts)),
              options: {
                ...base,
                // Sends `session_state_changed`. Its idle is the only signal that background sub-agents are done.
                env: { ...base.env, CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: "1" },
                cwd: input.cwd,
                model: input.model,
                ...(effort === null ? {} : { effort }),
                settings: {
                  fastMode: input.fastMode,
                  ...(input.autoCompactTokens !== null && { autoCompactWindow: input.autoCompactTokens }),
                  ...(input.effort === ULTRACODE && { ultracode: true }),
                  ...(hidden !== null && { skillOverrides: hidden }),
                },
                ...(resume === undefined ? {} : { resume }),
                ...(input.forkAt !== null && { forkSession: true, resumeSessionAt: input.forkAt }),
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
                mcpServers: { hinacode: hinacodeMcpServer(input.mcpServer) },
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
          userSkills: input.userSkills,
          autoCompactTokens: input.autoCompactTokens,
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
          lastAssistantUuid: null,
          turn: null,
          interrupted: false,
          turnPrompts: new Set(),
          unanswered: new Set(),
          answering: [],
          tasks: new Map(),
          taskSnapshots: false,
          backgroundTasks: [],
          wakeupCall: null,
          wakeup: null,
          reportsState: false,
          heldEnd: null,
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
          // The CLI lists skills to the model and reads the auto-compact window once per process, so a
          // change to either needs a new one.
          if (
            sameContext(existing, input) &&
            existing.userSkills === input.userSkills &&
            existing.autoCompactTokens === input.autoCompactTokens
          )
            return claim(existing)
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

    const openTurn = (session: Session, turn: TurnQueue) => {
      session.turn = turn
      resetTurnLimits(session)
      session.interrupted = false
      session.heldEnd = null
      session.turnPrompts.clear()
      session.lastRequest = null
    }

    /** A consumer that stops reading mid-turn means the turn should stop too. */
    const abandon = (session: Session, turn: TurnQueue) =>
      session.turn === turn
        ? Effect.sync(() => {
            session.turn = null
            session.turnPrompts.clear()
          }).pipe(Effect.andThen(interruptQuery(session)))
        : Effect.void

    /** The CLI started work by itself, such as resuming a sub-agent whose background shell finished. */
    const wake = (session: Session) =>
      Effect.gen(function* () {
        const { sessionId } = session
        if (sessionId === null) return
        const turn: TurnQueue = yield* Queue.unbounded<AgentEvent, AgentError | Cause.Done>()
        session.reportsState = true
        openTurn(session, turn)
        const events = Stream.fromQueue(turn).pipe(Stream.ensuring(Effect.suspend(() => abandon(session, turn))))
        yield* Queue.offer(wakes, {
          threadId: session.threadId,
          sessionId,
          events,
          discard: Effect.suspend(() => abandon(session, turn)),
        })
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
                effortLevel: effortLevelOf(input.effort),
                ultracode: input.effort === ULTRACODE,
                fastMode: input.fastMode,
              }),
            catch: agentError("Failed to switch effort or fast mode"),
          })
          session.effort = input.effort
          session.fastMode = input.fastMode
        }
        yield* switchPermissionMode(session, mode)
        const message = yield* userMessage(withUltrathink(input.prompt, input.effort), input.attachments)
        if (session.turn !== null) {
          return yield* new AgentError({
            provider: "claude",
            message: "A turn is already running on this thread",
          })
        }
        openTurn(session, turn)
        session.turnPrompts.add(message.uuid)
        session.unanswered.add(message.uuid)
        yield* Effect.addFinalizer(() => abandon(session, turn))
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
        session.turnPrompts.add(message.uuid)
        session.unanswered.add(message.uuid)
        for (const attachment of attachments) session.attachmentPaths.add(attachment.path)
        yield* Queue.offer(session.prompts, message)
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
          efforts: model.supportsEffort ? effortsOf(model.supportedEffortLevels ?? []) : [],
          defaultEffort: null,
          fastMode: model.supportsFastMode ?? false,
          autoMode: model.supportsAutoMode ?? false,
        })
      }
      return [...byId.values()]
    })

    // A failure is not cached, so a fresh install of Claude Code shows its models right away.
    const cachedModels = yield* Effect.cachedWithTTL(fetchModels, (exit) =>
      Exit.isSuccess(exit) ? Duration.minutes(10) : Duration.zero,
    )
    const listModels = Effect.orElseSucceed(cachedModels, () => FALLBACK_MODELS)

    const transcriptUsage = perHome(makeTranscriptUsage)
    const usage = (sessionId: string, home: AccountHome | null) =>
      Effect.tryPromise({
        try: () => transcriptUsage(home?.dir ?? claudeHome())(sessionId),
        catch: agentError("Failed to read Claude transcripts"),
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
        return session !== undefined && session.userSkills && session.cwd === cwd && sameHome(session.home, home)
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
      copySession,
      listCommands,
      runTurn,
      wakes: Stream.fromQueue(wakes),
      backgroundTasks: {
        changes: Stream.fromQueue(backgroundTaskChanges),
        // A background task's id is its CLI task id, like a sub-agent's.
        stop: (threadId, taskId) =>
          Effect.suspend(() => {
            const session = sessions.get(threadId)
            if (session === undefined) return Effect.void
            return lease(session, (leased) =>
              Effect.tryPromise({
                try: () => leased.query.stopTask(taskId),
                catch: agentError("Failed to stop the background task"),
              }),
            )
          }),
      },
      steer,
      interrupt: (threadId) => {
        const session = sessions.get(threadId)
        return session === undefined ? Effect.void : interruptQuery(session)
      },
      closeSession: (threadId) =>
        Effect.sync(() => {
          resumable.delete(threadId)
          const session = sessions.get(threadId)
          if (session !== undefined) closeSessionUnsafe(session)
        }),
      contextBreakdown: (threadId) =>
        Effect.suspend(() => {
          const session = sessions.get(threadId)
          if (session === undefined) return Effect.succeed(null)
          return lease(session, (leased) =>
            Effect.tryPromise({
              try: () => leased.query.getContextUsage(),
              catch: agentError("Failed to read the context usage"),
            }),
          ).pipe(Effect.map(toContextBreakdown))
        }),
      // A sub-agent's id is its CLI task id.
      stopSubagent: (threadId, subagentId) =>
        Effect.suspend(() => {
          const session = sessions.get(threadId)
          if (session === undefined) return Effect.void
          return lease(session, (leased) =>
            Effect.tryPromise({
              try: () => leased.query.stopTask(subagentId),
              catch: agentError("Failed to stop the sub-agent"),
            }),
          )
        }),
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
