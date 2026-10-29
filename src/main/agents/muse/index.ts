import { randomUUID } from "node:crypto"
import { readFile } from "node:fs/promises"
import {
  Context,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Queue,
  Schema,
  Scope,
  Semaphore,
  Stream,
} from "effect"
import type {
  AccountHome,
  AgentEvent,
  ApprovalDecision,
  BackgroundTask,
  Compaction,
  ContextWindow,
  QuestionAnswers,
  RunTurnInput,
  SessionScope,
} from "../../../shared/agent.ts"
import type { AccessMode, Attachment } from "../../../shared/domain.ts"
import { installedBinary } from "../binary.ts"
import { attachmentContext } from "../elementContext.ts"
import { COMPACT_COMMAND, isCompactCommand } from "../compact.ts"
import { AgentError, type AgentProvider, type BackgroundTasksChange, type Wake } from "../provider.ts"
import { choiceFor, sessionScope, toApprovalRequest } from "./approvals.ts"
import { backgroundTasksAfter, isBackgrounded } from "./backgroundTasks.ts"
import { toAccount, toModelInfo } from "./catalog.ts"
import { type Incoming, makeMuseHost, type MuseHost, REQUEST_TIMEOUT, toAgentError } from "./host.ts"
import { editedPath, toolInput, toolName, toolResult } from "./items.ts"
import { toPlanLimits } from "./limits.ts"
import {
  AccountState,
  type ApprovalRequestParams,
  type ApprovalResolvedParams,
  type ApprovalUpdatedParams,
  type Item,
  type ItemCompletedParams,
  type ItemDeltaParams,
  type ItemStartedParams,
  type ItemUpdatedParams,
  ModelList,
  type SessionCompactResult,
  type SessionContextUsageParams,
  type SessionResumeResult,
  type SessionStartResult,
  SkillList,
  SubscriptionUsage,
  ToolCallFrame,
  type TurnCompletedParams,
  type TurnInputPart,
  type TurnModelRetryScheduledParams,
  type TurnStartResult,
  type UserInputRequestParams,
  type UserInputSettledParams,
  SessionLeaveAck,
  SessionLeaveCompleted,
  ViewPage,
} from "./protocol.ts"
import { toAnswers, toQuestion } from "./questions.ts"
import { parseSkillInvocation, toCommand } from "./skills.ts"
import { applySubagentItem, type Subagents } from "./subagents.ts"
import { makeSessionUsage } from "./usage.ts"

const CLIENT_VERSION = "0.1.0"

/** `--trust-workspace` loads the project's skills and rules, since importing a project trusts it. */
const HOST_ARGS = ["serve", "--trust-workspace"]

/**
 * Muse's built-in permission profiles, the ones its own picker lists. Each sets the sandbox, network and approval
 * mode together, so a thread behaves the same here as in the Muse TUI.
 */
const permissionProfiles: Record<AccessMode, string> = {
  supervised: ":ask-me",
  auto: ":auto-review",
  full: ":unrestricted",
}

/** The size Claude Code accepts inline. A larger image goes in as a path, and Muse re-encodes it when it reads it. */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"])

const museError = (message: string) => new AgentError({ provider: "muse", message })

const interruptedEvent: AgentEvent = { type: "turn_failed", message: "Turn interrupted" }

/** Each part of a reasoning summary starts its own paragraph. */
const SUMMARY_BREAK = "\n\n"

/** What a host knows about each session it loaded, so a turn only sends the changes. */
interface LoadedSession {
  model: string | null
  /** Null when the session was loaded without picking one, such as a probe session. */
  permissionProfile: string | null
  cwd: string
  /** The context size Muse last reported, null until it reports one. */
  usedTokens: number | null
  /** True while a compaction runs, which may outlive the turn that asked for it. */
  compacting: boolean
}

interface HostEntry {
  readonly host: MuseHost
  readonly scope: Scope.Closeable
  /** A session stays loaded in the host that opened it; another host gets `sessionInUse` until this one exits. */
  readonly sessions: Map<string, LoadedSession>
  /** Each session's tool calls running in the background. They end with the host. */
  readonly backgroundTasks: Map<string, ReadonlyArray<BackgroundTask>>
}

/** A turn on one hinacode thread, from the moment it is asked for until its stream ends. */
type Run = {
  /** Completed by Stop when there is no started remote turn to interrupt. */
  readonly stop: Deferred.Deferred<void>
  entry?: HostEntry
  sessionId?: string
  /** Outlives a stopped run, so a turn Muse starts after Stop can still be interrupted. */
  turnStart?: Fiber.Fiber<string, AgentError>
  turnId?: string
  /** Set as soon as Muse completes `turnId`, while the run's stream may still be winding down. */
  ended: boolean
}

/** A turn Muse started by itself. Its notifications wait in `inbox` until the runner follows it. */
interface WakeTurn {
  readonly turnId: string
  readonly inbox: Queue.Queue<Incoming>
  ended: boolean
}

/**
 * A pending Muse approval. Muse asks once per stage of a compound command, and the user's one answer covers them
 * all: Muse 1.4.7 moves to the next stage with an `approval/updated`, not the re-issued `approval/request` MSP's
 * reference describes, so both lead here.
 */
interface Approval {
  readonly id: string
  /** The latest choices and current stage. */
  params: ApprovalRequestParams
  decision: ApprovalDecision | undefined
  /** False when a session grant answered it without asking. */
  presented: boolean
  /** The stage answered last, so no stage is answered twice. */
  answered: number | undefined
}

const grantKey = (scope: SessionScope) => JSON.stringify([scope.tool, scope.kind, scope.value])

const textPart = (text: string): TurnInputPart => ({ type: "text", text })

/** Images go in as data, a picked element with its context; other files are named by path for Muse to read. */
const userInput = (text: string, attachments: ReadonlyArray<Attachment>) =>
  Effect.forEach(attachments, (attachment) => {
    if (attachment.kind !== "image" || !IMAGE_TYPES.has(attachment.mime) || attachment.bytes > MAX_IMAGE_BYTES) {
      return Effect.succeed([textPart(`Attached file: ${attachment.path}`)])
    }
    return Effect.tryPromise({
      try: () => readFile(attachment.path),
      catch: (cause) => museError(`Failed to read ${attachment.name}: ${String(cause)}`),
    }).pipe(
      Effect.map((data): Array<TurnInputPart> => {
        const context = attachmentContext(attachment)
        return [
          { type: "image", base64Data: data.toString("base64"), mediaType: attachment.mime },
          ...(context === null ? [] : [textPart(context)]),
        ]
      }),
    )
  }).pipe(Effect.map((parts) => [...(text === "" ? [] : [textPart(text)]), ...parts.flat()]))

const listSkills = (host: MuseHost, sessionId: string) =>
  Effect.gen(function* () {
    const raw = yield* host.request("skill/list", { sessionId }).pipe(Effect.mapError(toAgentError))
    const { skills } = yield* Schema.decodeUnknownEffect(SkillList)(raw).pipe(
      Effect.mapError(() => museError("Failed to list the Muse Code skills: invalid response")),
    )
    return skills
  })

/**
 * The parts one prompt goes in as, hinacode's instructions first. A prompt typed as `/skill arguments`
 * becomes the `skill` part the host expands, the wire twin of the TUI's typed dispatch. A skill part
 * combines only with image parts, so a skill turn folds its file notes into the skill arguments and
 * leaves the instructions to the next text turn, which sends them again anyway. Text the session has
 * no skill for goes in as typed.
 */
const promptParts = (
  host: MuseHost,
  sessionId: string,
  text: string,
  attachments: ReadonlyArray<Attachment>,
  instructions: string | null,
) =>
  Effect.gen(function* () {
    const invocation = text.trimStart().startsWith("/")
      ? yield* listSkills(host, sessionId).pipe(
          Effect.map((skills) => parseSkillInvocation(text, new Set(skills.map((skill) => skill.selector)))),
          Effect.catch(() => Effect.succeed(null)),
        )
      : null
    if (invocation === null) {
      const parts = yield* userInput(text, attachments)
      return instructions === null ? parts : [textPart(instructions), ...parts]
    }
    const attached = yield* userInput("", attachments)
    const notes = attached.flatMap((part) => (part.type === "text" && part.text !== undefined ? [part.text] : []))
    const images = attached.filter((part) => part.type === "image")
    const args = [invocation.arguments, ...notes].filter((note) => note !== "").join("\n")
    const skill: TurnInputPart = {
      type: "skill",
      selector: invocation.selector,
      ...(args === "" ? {} : { arguments: args }),
    }
    return [skill, ...images]
  })

/** Keeps each loaded session's context size and compaction state current, between turns too. */
const trackContext = (sessions: Map<string, LoadedSession>, method: string, params: unknown) => {
  const session = sessions.get((params as { sessionId?: string } | undefined)?.sessionId ?? "")
  if (session === undefined) return
  if (method === "session/contextUsage") session.usedTokens = (params as SessionContextUsageParams).usedTokens
  if ((params as { item?: Item }).item?.kind !== "compaction") return
  if (method === "item/started") session.compacting = true
  if (method === "item/completed") session.compacting = false
}

const decodeContextUsage = Schema.decodeUnknownOption(Schema.Struct({ usedTokens: Schema.Number }))

/** The session's latest context size, read backward from the end of its view so no item history loads. */
const latestUsedTokens = (host: MuseHost, sessionId: string) =>
  Effect.gen(function* () {
    let cursor: string | null = null
    do {
      const raw: unknown = yield* host.request("view/page", {
        sessionId,
        direction: "backward",
        limit: 100,
        ...(cursor === null ? {} : { cursor }),
      })
      const page: ViewPage = yield* Schema.decodeUnknownEffect(ViewPage)(raw)
      const usage = page.events.findLast((event) => event.method === "session/contextUsage")
      if (usage !== undefined) return Option.getOrNull(decodeContextUsage(usage.params))?.usedTokens ?? null
      cursor = page.nextCursor
    } while (cursor !== null)
    return null
  }).pipe(Effect.catch(() => Effect.succeed(null)))

const interruptTurn = (host: MuseHost, sessionId: string, turnId: string) =>
  Effect.suspend(() =>
    host.isAlive()
      ? host.command("turn/interrupt", { sessionId, turnId }).pipe(Effect.mapError(toAgentError))
      : Effect.void,
  )

const decodeLeaveCompleted = Schema.decodeUnknownOption(SessionLeaveCompleted)

/**
 * `session/leave` with `stop` cancels the session's turns and background shells and unloads it from the host. Its
 * answer only admits the leave, and `session/leaveCompleted` reports when the host let go. A host that exits
 * takes its sessions with it.
 */
const leaveSession = (host: MuseHost, sessionId: string) =>
  Effect.gen(function* () {
    const inbox = yield* Queue.unbounded<Incoming>()
    yield* host.subscribe((message) => Queue.offerUnsafe(inbox, message))
    const ack = yield* host.command("session/leave", { sessionId, stop: true }).pipe(Effect.mapError(toAgentError))
    const { commandId } = yield* Schema.decodeUnknownEffect(SessionLeaveAck)(ack).pipe(
      Effect.mapError(() => museError("session/leave: invalid response")),
    )
    while (true) {
      const message = yield* Queue.take(inbox)
      if (message.kind === "exit") return
      if (message.kind !== "notification" || message.method !== "session/leaveCompleted") continue
      const completed = decodeLeaveCompleted(message.params)
      if (Option.isNone(completed) || completed.value.commandId !== commandId) continue
      const { outcome, reason } = completed.value
      if (outcome === "released") return
      return yield* museError(`session/leave: ${outcome}${reason === undefined ? "" : ` (${reason})`}`)
    }
  }).pipe(
    Effect.timeoutOrElse({
      duration: REQUEST_TIMEOUT,
      orElse: () => Effect.fail(museError(`session/leave did not complete within ${Duration.format(REQUEST_TIMEOUT)}`)),
    }),
    Effect.scoped,
  )

const make = Effect.gen(function* () {
  const providerScope = yield* Effect.scope
  const hostLock = yield* Semaphore.make(1)
  let current: HostEntry | undefined
  /** The plan usage the host last reported. A fresh host has none until it makes a model call. */
  let planUsage: SubscriptionUsage | undefined
  const decodePlanUsage = Schema.decodeUnknownOption(SubscriptionUsage)
  const decodeToolCall = Schema.decodeUnknownOption(ToolCallFrame)
  const backgroundTaskChanges = yield* Queue.unbounded<BackgroundTasksChange>()

  const threadOf = (sessionId: string) =>
    [...threadSessions.entries()].find(([, session]) => session === sessionId)?.[0]

  const setBackgroundTasks = (entry: HostEntry, sessionId: string, tasks: ReadonlyArray<BackgroundTask>) => {
    if ((entry.backgroundTasks.get(sessionId) ?? []) === tasks) return
    if (tasks.length === 0) entry.backgroundTasks.delete(sessionId)
    else entry.backgroundTasks.set(sessionId, tasks)
    const threadId = threadOf(sessionId)
    if (threadId !== undefined) Queue.offerUnsafe(backgroundTaskChanges, { threadId, tasks })
  }

  /** Follows tool calls into and out of the background, after their turn too, since MSP has no task-set event. */
  const trackBackgroundTasks = (entry: HostEntry, message: Incoming) => {
    if (message.kind === "exit") {
      for (const sessionId of entry.backgroundTasks.keys()) setBackgroundTasks(entry, sessionId, [])
      return
    }
    if (message.kind !== "notification") return
    if (message.method === "session/closed") {
      const sessionId = (message.params as { sessionId?: string } | undefined)?.sessionId
      if (sessionId !== undefined) setBackgroundTasks(entry, sessionId, [])
      return
    }
    if (message.method !== "item/updated" && message.method !== "item/completed") return
    const frame = decodeToolCall(message.params)
    if (Option.isNone(frame)) return
    const { sessionId, item } = frame.value
    const previous = entry.backgroundTasks.get(sessionId) ?? []
    setBackgroundTasks(entry, sessionId, backgroundTasksAfter(previous, item, new Date().toISOString()))
  }

  /** Spawned on first use and respawned after it dies, like Codex's app-server. */
  const getEntry = (home: AccountHome | null) =>
    Semaphore.withPermit(
      hostLock,
      Effect.gen(function* () {
        // An added account is a home directory, and Muse has none of its own, so it only runs on its CLI login.
        if (home !== null) return yield* museError("Muse Code runs on its CLI login only")
        if (current?.host.isAlive()) return current
        if (current) yield* Scope.close(current.scope, Exit.void)
        const binaryPath = yield* installedBinary("muse", "muse")
        const scope = yield* Scope.make()
        const host = yield* makeMuseHost({
          binaryPath,
          args: HOST_ARGS,
          env: { ...process.env },
          clientVersion: CLIENT_VERSION,
        }).pipe(
          Scope.provide(scope),
          Effect.onError(() => Scope.close(scope, Exit.void)),
        )
        const entry: HostEntry = { host, scope, sessions: new Map(), backgroundTasks: new Map() }
        yield* host
          .subscribe((message) => {
            trackBackgroundTasks(entry, message)
            trackTurns(entry, message)
            if (message.kind !== "notification") return
            if (message.method === "usage/changed") {
              planUsage = Option.getOrElse(decodePlanUsage(message.params), () => planUsage)
            } else {
              trackContext(entry.sessions, message.method, message.params)
            }
          })
          .pipe(Scope.provide(scope))
        current = entry
        return current
      }),
    )
  yield* Effect.addFinalizer(() => (current ? Scope.close(current.scope, Exit.void) : Effect.void))

  const getHost = (home: AccountHome | null) => getEntry(home).pipe(Effect.map((entry) => entry.host))

  /** Pending approvals keyed by the hinacode approval id handed to the UI. */
  const approvals = new Map<string, Deferred.Deferred<ApprovalDecision>>()
  /** Pending questions keyed by the hinacode question id handed to the UI. */
  const questions = new Map<string, Deferred.Deferred<QuestionAnswers>>()
  /** Each thread's Muse session, so `skill/list` can ask the session a turn would run in. */
  const threadSessions = new Map<string, string>()
  /** Sub-agents each thread's agent spawned, kept across its turns like Codex's. */
  const subagentsByThread = new Map<string, Subagents>()
  /**
   * One throwaway session per workspace, started only to read its `skill/list` before the thread's first
   * turn. It never runs a turn, and a respawned host resumes it instead of starting another.
   */
  const probeSessions = new Map<string, string>()
  const probeLock = yield* Semaphore.make(1)
  /** In-flight runs keyed by hinacode threadId, for steer, interrupt and access mode changes. */
  const runs = new Map<string, Run>()
  /** "Allow for session" grants keyed by hinacode threadId. They last until hinacode quits. */
  const grants = new Map<string, Set<string>>()
  const wakes = yield* Queue.unbounded<Wake>()
  /** Turns Muse started by itself, keyed by session, from `turn/started` until the runner is done with them. */
  const wakeTurns = new Map<string, WakeTurn>()

  const isFollowed = (threadId: string, sessionId: string) => {
    const run = runs.get(threadId)
    const wake = wakeTurns.get(sessionId)
    return (run !== undefined && !run.ended) || (wake !== undefined && !wake.ended)
  }

  /**
   * Muse starts a turn by itself, such as to answer a background shell that finished after the turn ended. When no
   * run follows the session, that turn becomes a wake. Its notifications are kept from `turn/started` on, so an
   * approval it asks for before the runner adopts it still reaches the user.
   */
  const trackTurns = (entry: HostEntry, message: Incoming) => {
    if (message.kind === "exit") {
      for (const wake of wakeTurns.values()) Queue.offerUnsafe(wake.inbox, message)
      return
    }
    const { sessionId, turnId } = (message.params ?? {}) as { sessionId?: string; turnId?: string }
    if (sessionId === undefined) return
    if (message.method === "turn/completed") {
      for (const turn of [...runs.values(), ...wakeTurns.values()]) if (turn.turnId === turnId) turn.ended = true
    }
    if (message.method === "turn/started" && turnId !== undefined) wake(entry, sessionId, turnId)
    const wakeTurn = wakeTurns.get(sessionId)
    if (wakeTurn !== undefined) Queue.offerUnsafe(wakeTurn.inbox, message)
  }

  const wake = (entry: HostEntry, sessionId: string, turnId: string) => {
    const threadId = threadOf(sessionId)
    if (threadId === undefined || isFollowed(threadId, sessionId)) return
    const wakeTurn: WakeTurn = { turnId, inbox: Effect.runSync(Queue.unbounded<Incoming>()), ended: false }
    wakeTurns.set(sessionId, wakeTurn)
    const release = Effect.sync(() => wakeTurns.get(sessionId) === wakeTurn && wakeTurns.delete(sessionId))
    const events = turnStream(threadId, (run, emit) =>
      Effect.gen(function* () {
        // A run started for the user's message took the turn over.
        if (wakeTurns.get(sessionId) !== wakeTurn) return
        Object.assign(run, { entry, sessionId, turnId })
        const { handle } = yield* followTurn(threadId, run, entry, sessionId, emit)
        while (!(yield* Queue.take(wakeTurn.inbox).pipe(Effect.flatMap(handle)))) {}
      }),
    )
    Queue.offerUnsafe(wakes, {
      threadId,
      sessionId,
      events: events.pipe(Stream.ensuring(release)),
      discard: release.pipe(Effect.andThen(interruptTurn(entry.host, sessionId, turnId)), Effect.ignore),
    })
  }

  const listModels = Effect.gen(function* () {
    const host = yield* getHost(null)
    const raw = yield* host.request("model/list", {}).pipe(Effect.mapError(toAgentError))
    const { models } = yield* Schema.decodeUnknownEffect(ModelList)(raw).pipe(
      Effect.mapError(() => museError("Failed to list the Muse Code models: invalid response")),
    )
    return models.map(toModelInfo)
  })

  const account = (home: AccountHome | null) =>
    Effect.gen(function* () {
      const host = yield* getHost(home)
      const raw = yield* host.request("account/read", {}).pipe(Effect.mapError(toAgentError))
      const state = yield* Schema.decodeUnknownEffect(AccountState)(raw).pipe(
        Effect.mapError(() => museError("Failed to read the Muse Code account: invalid response")),
      )
      return toAccount(state)
    })

  const planLimits = (home: AccountHome | null) =>
    Effect.sync(() => (home === null && planUsage !== undefined ? toPlanLimits(planUsage) : null))

  const readUsage = makeSessionUsage((params) =>
    Effect.gen(function* () {
      const host = yield* getHost(null)
      const raw = yield* host.request("view/page", params)
      return yield* Schema.decodeUnknownEffect(ViewPage)(raw).pipe(
        Effect.mapError(() => museError("Failed to read the Muse Code session: invalid response")),
      )
    }),
  )

  const usage = (sessionId: string, home: AccountHome | null) =>
    home === null
      ? readUsage(sessionId).pipe(
          Effect.mapError((error) => (error._tag === "MuseCallError" ? toAgentError(error) : error)),
        )
      : Effect.succeed(null)

  const probeSession = (entry: HostEntry, cwd: string) =>
    Semaphore.withPermit(
      probeLock,
      Effect.gen(function* () {
        const { host, sessions } = entry
        const known = probeSessions.get(cwd)
        if (known !== undefined && sessions.has(known)) return known
        if (known !== undefined) {
          const resumed = yield* host
            .command<SessionResumeResult>("session/resume", { sessionId: known, excludeItems: true })
            .pipe(
              Effect.map(({ session }) => session),
              Effect.catch(() => Effect.succeed(undefined)),
            )
          if (resumed !== undefined) {
            sessions.set(known, {
              model: resumed.modelId,
              permissionProfile: null,
              cwd,
              usedTokens: null,
              compacting: false,
            })
            return known
          }
        }
        const { session } = yield* host
          .command<SessionStartResult>("session/start", { workspaceRoot: cwd })
          .pipe(Effect.mapError(toAgentError))
        sessions.set(session.sessionId, {
          model: session.modelId ?? null,
          permissionProfile: null,
          cwd,
          usedTokens: null,
          compacting: false,
        })
        probeSessions.set(cwd, session.sessionId)
        return session.sessionId
      }),
    )

  const listCommands = ({
    threadId,
    cwd,
    home,
  }: {
    readonly threadId: string
    readonly cwd: string
    readonly home: AccountHome | null
  }) =>
    Effect.gen(function* () {
      const entry = yield* getEntry(home)
      const own = threadSessions.get(threadId)
      const inWorkspace = [...entry.sessions.entries()].find(([, session]) => session.cwd === cwd)?.[0]
      const sessionId =
        own !== undefined && entry.sessions.has(own) ? own : (inWorkspace ?? (yield* probeSession(entry, cwd)))
      const skills = yield* listSkills(entry.host, sessionId)
      return [COMPACT_COMMAND, ...skills.map(toCommand)]
    })

  /** Starts the thread's session or loads it into the host, then brings its model and permission profile up to date. */
  const openSession = (entry: HostEntry, input: RunTurnInput) =>
    Effect.gen(function* () {
      const { host, sessions } = entry
      const permissionProfile = permissionProfiles[input.accessMode]
      // Each session carries its own thread's credential for the hinacode MCP server.
      const config = {
        mcpServers: {
          hinacode: { transport: "streamableHttp", url: input.mcpServer.url, headers: { ...input.mcpServer.headers } },
        },
      }
      if (input.resumeSessionId === null) {
        const { session } = yield* host.command<SessionStartResult>("session/start", {
          workspaceRoot: input.cwd,
          modelId: input.model,
          permissionProfile,
          config,
        })
        sessions.set(session.sessionId, {
          model: input.model,
          permissionProfile,
          cwd: input.cwd,
          usedTokens: null,
          compacting: false,
        })
        threadSessions.set(input.threadId, session.sessionId)
        return session.sessionId
      }
      const sessionId = input.resumeSessionId
      let loaded = sessions.get(sessionId)
      if (loaded === undefined) {
        const { session } = yield* host.command<SessionResumeResult>("session/resume", {
          sessionId,
          excludeItems: true,
          permissionProfile,
          config,
        })
        loaded = {
          model: session.modelId,
          permissionProfile,
          cwd: input.cwd,
          // An `excludeItems` resume carries no context usage.
          usedTokens: input.autoCompactTokens === null ? null : yield* latestUsedTokens(host, sessionId),
          compacting: false,
        }
        sessions.set(sessionId, loaded)
      }
      threadSessions.set(input.threadId, sessionId)
      if (loaded.model !== input.model) {
        yield* host.command("session/setModel", { sessionId, model: { modelId: input.model } })
        loaded.model = input.model
      }
      if (loaded.permissionProfile !== permissionProfile) {
        yield* host.command("session/setPermissionProfile", { sessionId, profileId: permissionProfile })
        loaded.permissionProfile = permissionProfile
      }
      return sessionId
    }).pipe(Effect.mapError(toAgentError))

  /**
   * Translates the session's notifications into one turn's events. `handle` answers true once Muse completes
   * `run.turnId`. Approvals and questions still open when the scope closes are denied or cancelled.
   */
  const followTurn = (
    threadId: string,
    run: Run,
    entry: HostEntry,
    sessionId: string,
    emit: (event: AgentEvent) => Effect.Effect<boolean>,
  ) =>
    Effect.gen(function* () {
      const { host } = entry
      const cwd = entry.sessions.get(sessionId)?.cwd ?? ""
      const threadGrants = grants.get(threadId) ?? new Set<string>()
      grants.set(threadId, threadGrants)
      let subagents = subagentsByThread.get(threadId)
      if (subagents === undefined) subagentsByThread.set(threadId, (subagents = new Map()))
      const pendingApprovals = new Map<string, Approval>()
      const pendingQuestions = new Map<string, { readonly id: string; readonly params: UserInputRequestParams }>()
      /** Text already shown per streamed item, so `item/completed` adds only what never arrived as a delta. */
      const shown = new Map<string, string>()
      /** The reasoning summary part each item streamed last. */
      const summaryParts = new Map<string, string>()
      const toolOutput = new Map<string, string>()
      const openTools = new Set<string>()
      /** Calls whose row closed when they went to the background; the tray follows them from there. */
      const backgroundedTools = new Set<string>()
      let context: ContextWindow | undefined
      /** How the compaction hinacode asked for started, while it runs. */
      const requestedCompaction: { trigger: "auto" | "manual" | null } = { trigger: null }
      /**
       * Muse retries a 429 without a reset time as a rate limit, and its giving up carries no `quota`. It is the
       * same wall to the user, so the turn ends limited, as a Claude 429 does.
       */
      let rateLimited = false

      const decide = (approval: Approval, decision: ApprovalDecision) =>
        Effect.gen(function* () {
          const stage = approval.params.currentRequirementId.sourceIndex
          if (approval.answered === stage) return
          approval.answered = stage
          const choice = choiceFor(decision, approval.params.availableChoices)
          if (choice === undefined) {
            return yield* Effect.logWarning("Muse offered no choice for the decision", decision)
          }
          yield* host
            .command("approval/decide", {
              sessionId,
              approvalId: approval.params.approvalId,
              requirementId: approval.params.currentRequirementId,
              choiceId: choice.choiceId,
            })
            .pipe(
              // A stage the host already settled, such as one it resolved while the answer was in flight.
              Effect.catch((error) => Effect.logWarning("approval/decide failed", error.message)),
            )
        })

      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          // The consumer went away mid-approval: deny instead of leaving Muse waiting.
          for (const approval of pendingApprovals.values()) {
            if (approvals.delete(approval.id) && approval.decision === undefined) yield* decide(approval, "deny")
          }
          for (const { id, params } of pendingQuestions.values()) {
            if (!questions.delete(id)) continue
            yield* host.command("userInput/cancel", { sessionId, userInputId: params.userInputId }).pipe(Effect.ignore)
          }
        }),
      )

      const requestApproval = (params: ApprovalRequestParams) =>
        Effect.gen(function* () {
          const known = pendingApprovals.get(params.approvalId)
          if (known !== undefined) {
            known.params = params
            if (known.decision !== undefined) yield* decide(known, known.decision)
            return
          }
          const approval: Approval = {
            id: randomUUID(),
            params,
            decision: undefined,
            presented: false,
            answered: undefined,
          }
          pendingApprovals.set(params.approvalId, approval)
          if (threadGrants.has(grantKey(sessionScope(params)))) {
            approval.decision = "allow"
            return yield* decide(approval, "allow")
          }
          approval.presented = true
          const deferred = yield* Deferred.make<ApprovalDecision>()
          approvals.set(approval.id, deferred)
          yield* emit({
            type: "approval_requested",
            request: toApprovalRequest(params, approval.id, threadId),
          })
          yield* Deferred.await(deferred).pipe(
            Effect.flatMap((decision) => {
              approval.decision = decision
              if (decision === "allow_for_session") threadGrants.add(grantKey(sessionScope(approval.params)))
              return decide(approval, decision)
            }),
            Effect.forkScoped,
          )
        })

      const updateApproval = (params: ApprovalUpdatedParams) =>
        Effect.gen(function* () {
          const known = pendingApprovals.get(params.approvalId)
          if (known === undefined) return
          const { availableChoices, currentRequirementId, subject } = params
          known.params = { ...known.params, availableChoices, currentRequirementId, subject }
          if (known.decision !== undefined) yield* decide(known, known.decision)
        })

      const resolveApproval = ({ approvalId }: ApprovalResolvedParams) =>
        Effect.gen(function* () {
          const approval = pendingApprovals.get(approvalId)
          if (approval === undefined) return
          pendingApprovals.delete(approvalId)
          approvals.delete(approval.id)
          if (approval.presented) yield* emit({ type: "approval_resolved", requestId: approval.id })
        })

      const requestQuestion = (params: UserInputRequestParams) =>
        Effect.gen(function* () {
          if (pendingQuestions.has(params.userInputId)) return
          const id = randomUUID()
          const answers = yield* Deferred.make<QuestionAnswers>()
          questions.set(id, answers)
          pendingQuestions.set(params.userInputId, { id, params })
          yield* emit({
            type: "question_requested",
            request: {
              id,
              threadId,
              provider: "muse",
              questions: params.questions.map(toQuestion),
            },
          })
          yield* Deferred.await(answers).pipe(
            Effect.flatMap((chosen) => {
              const answered = toAnswers(params.questions, chosen)
              return answered === null
                ? host.command("userInput/cancel", { sessionId, userInputId: params.userInputId })
                : host.command("userInput/answer", {
                    sessionId,
                    userInputId: params.userInputId,
                    answers: answered,
                  })
            }),
            Effect.catch((error) => Effect.logWarning("answering a Muse question failed", error.message)),
            Effect.forkScoped,
          )
        })

      const resolveQuestion = ({ userInputId }: UserInputSettledParams) =>
        Effect.gen(function* () {
          const pending = pendingQuestions.get(userInputId)
          if (pending === undefined) return
          pendingQuestions.delete(userInputId)
          questions.delete(pending.id)
          yield* emit({ type: "question_resolved", requestId: pending.id })
        })

      const startTool = (item: Item) => {
        if (item.tool === undefined || openTools.has(item.itemId)) return Effect.void
        openTools.add(item.itemId)
        return emit({
          type: "tool_call_started",
          callId: item.itemId,
          name: toolName(item.tool),
          input: toolInput(item.args),
        })
      }

      const backgroundTool = (params: unknown) =>
        Effect.gen(function* () {
          const frame = decodeToolCall(params)
          if (Option.isNone(frame)) return
          const { item } = frame.value
          if (!isBackgrounded(item) || !openTools.has(item.itemId)) return
          openTools.delete(item.itemId)
          toolOutput.delete(item.itemId)
          backgroundedTools.add(item.itemId)
          yield* emit({
            type: "tool_call_finished",
            callId: item.itemId,
            output: "Running in the background",
            isError: false,
          })
        })

      const finishTool = (item: Item) =>
        Effect.gen(function* () {
          if (item.tool === undefined || backgroundedTools.has(item.itemId)) return
          yield* startTool(item)
          openTools.delete(item.itemId)
          yield* emit({
            type: "tool_call_finished",
            callId: item.itemId,
            ...toolResult(item, toolOutput.get(item.itemId)),
          })
          toolOutput.delete(item.itemId)
          const path = editedPath(item, cwd)
          if (path !== undefined) yield* emit({ type: "file_changed", path })
        })

      /** Emits whatever part of the final text never arrived as a delta, such as after a gap in the stream. */
      const finishText = (item: Item, type: "text_delta" | "reasoning_delta", text: string) =>
        Effect.gen(function* () {
          const seen = shown.get(item.itemId) ?? ""
          shown.delete(item.itemId)
          const rest = text.startsWith(seen) ? text.slice(seen.length) : ""
          if (rest !== "") yield* emit({ type, text: rest })
        })

      const onDelta = ({ itemId, field = "text", delta }: ItemDeltaParams) =>
        Effect.gen(function* () {
          if (field === "output") {
            toolOutput.set(itemId, (toolOutput.get(itemId) ?? "") + delta)
            return
          }
          const reasoning = field.startsWith("summary.")
          if (field !== "text" && !reasoning) return
          const previousPart = summaryParts.get(itemId)
          if (reasoning) summaryParts.set(itemId, field)
          const text = previousPart !== undefined && previousPart !== field ? `${SUMMARY_BREAK}${delta}` : delta
          shown.set(itemId, (shown.get(itemId) ?? "") + text)
          yield* emit({ type: reasoning ? "reasoning_delta" : "text_delta", text })
        })

      const emitSubagent = (item: Item) => {
        const changed = applySubagentItem(subagents, item, new Date().toISOString())
        return changed === undefined ? Effect.void : emit({ type: "subagent_updated", subagent: changed })
      }

      const onCompleted = (item: Item) => {
        switch (item.kind) {
          case "agentMessage":
            return finishText(item, "text_delta", item.text ?? "")
          case "reasoning":
            summaryParts.delete(item.itemId)
            return finishText(item, "reasoning_delta", (item.summary ?? []).join(SUMMARY_BREAK))
          case "toolCall":
            return finishTool(item)
          case "subagent":
            return emitSubagent(item)
          case "compaction":
            return finishCompaction(item)
          default:
            return Effect.void
        }
      }

      /** A noop leaves the context as small as Muse can make it, which reads as done rather than failed. */
      const finishCompaction = (item: Item) => {
        const trigger = requestedCompaction.trigger ?? (item.trigger === "manual" ? "manual" : "auto")
        requestedCompaction.trigger = null
        const compaction: Compaction =
          item.outcome === "compacted" || item.outcome === "noop"
            ? {
                status: "done",
                trigger,
                preTokens: item.tokensBefore ?? null,
                postTokens: item.tokensAfter ?? null,
              }
            : { status: "failed", message: item.reason ?? null }
        return emit({ type: "compaction_updated", compaction })
      }

      const finishTurn = (params: TurnCompletedParams) =>
        Effect.gen(function* () {
          // A stopped turn may complete without item/completed for the tools it cut off.
          for (const callId of openTools) {
            const output = toolOutput.get(callId) ?? `Turn ${params.terminal}`
            yield* emit({ type: "tool_call_finished", callId, output, isError: true })
          }
          openTools.clear()
          if (params.terminal === "completed") {
            return yield* emit({
              type: "turn_completed",
              usage: {
                inputTokens: params.usage?.inputTokens ?? 0,
                outputTokens: params.usage?.outputTokens ?? 0,
                ...(context && { context }),
              },
            })
          }
          if (params.terminal === "cancelled") return yield* emit(interruptedEvent)
          const quota = params.error?.quota
          if (quota !== undefined || rateLimited) {
            return yield* emit({
              type: "turn_limited",
              limit: {
                kind: "usage",
                message: params.error?.message ?? "Muse Code usage limit reached",
                reset: quota === undefined ? null : { at: new Date(quota.resetsAtMs).toISOString(), autoResume: false },
              },
            })
          }
          yield* emit({
            type: "turn_failed",
            message: params.error?.message ?? params.reason ?? `Turn ${params.terminal}`,
          })
        })

      /** Returns true once the turn is over. */
      const handle = (message: Incoming): Effect.Effect<boolean, AgentError, Scope.Scope> =>
        Effect.gen(function* () {
          if (message.kind === "exit") return yield* Effect.fail(message.error)
          if ((message.params as { sessionId?: string } | undefined)?.sessionId !== sessionId) return false
          if (message.kind === "request") {
            if (message.method === "approval/request") {
              yield* requestApproval(message.params as ApprovalRequestParams)
            } else if (message.method === "userInput/request") {
              yield* requestQuestion(message.params as UserInputRequestParams)
            }
            return false
          }
          switch (message.method) {
            case "item/started": {
              const { item } = message.params as ItemStartedParams
              if (item.kind === "toolCall") yield* startTool(item)
              if (item.kind === "subagent") yield* emitSubagent(item)
              if (item.kind === "compaction") {
                yield* emit({ type: "compaction_updated", compaction: { status: "running" } })
              }
              return false
            }
            case "item/updated": {
              yield* backgroundTool(message.params)
              const { item } = message.params as ItemUpdatedParams
              if (item.kind === "subagent") yield* emitSubagent(item)
              return false
            }
            case "item/delta":
              yield* onDelta(message.params as ItemDeltaParams)
              return false
            case "item/completed":
              yield* onCompleted((message.params as ItemCompletedParams).item)
              return false
            case "approval/updated":
              yield* updateApproval(message.params as ApprovalUpdatedParams)
              return false
            case "approval/resolved":
              yield* resolveApproval(message.params as ApprovalResolvedParams)
              return false
            case "userInput/settled":
              yield* resolveQuestion(message.params as UserInputSettledParams)
              return false
            case "turn/modelRetryScheduled":
              rateLimited = (message.params as TurnModelRetryScheduledParams).httpStatus === 429
              return false
            case "session/contextUsage": {
              const { usedTokens, windowTokens } = message.params as SessionContextUsageParams
              if (windowTokens !== undefined) context = { usedTokens, maxTokens: windowTokens }
              return false
            }
            case "turn/completed": {
              const params = message.params as TurnCompletedParams
              if (params.turnId !== run.turnId) return false
              yield* finishTurn(params)
              return true
            }
            default:
              return false
          }
        })

      return { handle, requestedCompaction }
    })

  /** A turn's event stream. Stop ends it with `interruptedEvent`, and interrupts the Muse turn once it has one. */
  const turnStream = (
    threadId: string,
    follow: (
      run: Run,
      emit: (event: AgentEvent) => Effect.Effect<boolean>,
    ) => Effect.Effect<void, AgentError, Scope.Scope>,
  ) =>
    Stream.callback<AgentEvent, AgentError>((out) =>
      Effect.gen(function* () {
        const emit = (event: AgentEvent) => Queue.offer(out, event)
        const run: Run = { stop: yield* Deferred.make<void>(), ended: false }
        runs.set(threadId, run)
        yield* Effect.addFinalizer(() => Effect.sync(() => runs.get(threadId) === run && runs.delete(threadId)))

        const stopped = yield* Effect.raceFirst(
          follow(run, emit).pipe(Effect.as(false)),
          Deferred.await(run.stop).pipe(Effect.as(true)),
        )
        if (stopped) {
          const { turnStart, entry, sessionId } = run
          if (turnStart && entry && sessionId) {
            yield* Fiber.join(turnStart).pipe(
              Effect.flatMap((turnId) => interruptTurn(entry.host, sessionId, turnId)),
              Effect.ignore,
              Effect.forkIn(providerScope),
            )
          }
          yield* emit(interruptedEvent)
        }
        yield* Queue.end(out)
      }),
    )

  const runTurn = (input: RunTurnInput): Stream.Stream<AgentEvent, AgentError> =>
    turnStream(input.threadId, (run, emit) =>
      Effect.gen(function* () {
        const entry = yield* getEntry(input.home)
        const { host } = entry
        run.entry = entry

        // Subscribe before starting so no notification is missed; they wait here until the turn id is known.
        const inbox = yield* Queue.unbounded<Incoming>()
        yield* host.subscribe((message) => Queue.offerUnsafe(inbox, message))

        const sessionId = yield* openSession(entry, input)
        run.sessionId = sessionId
        yield* emit({ type: "session_bound", providerSessionId: sessionId })
        const { handle, requestedCompaction } = yield* followTurn(input.threadId, run, entry, sessionId, emit)

        // MSP takes no compaction threshold, so hinacode compacts before the turn. Muse rejects a turn/start that
        // arrives during a compaction with `runtime_busy` and has no call that cancels one, so the turn waits for
        // the compaction item to settle, including one a stopped turn left running.
        const compacting = isCompactCommand(input.prompt)
        const loaded = entry.sessions.get(sessionId)
        const usedTokens = loaded?.usedTokens ?? null
        if (loaded?.compacting) {
          requestedCompaction.trigger = "auto"
          yield* emit({ type: "compaction_updated", compaction: { status: "running" } })
        } else if (compacting) {
          const ack = yield* host
            .command<SessionCompactResult>("session/compact", { sessionId })
            .pipe(Effect.mapError(toAgentError))
          if (ack.status === "accepted") requestedCompaction.trigger = "manual"
          else {
            // A noop means there is nothing left to summarize.
            yield* emit({
              type: "compaction_updated",
              compaction: { status: "done", trigger: "manual", preTokens: null, postTokens: null },
            })
          }
        } else if (input.autoCompactTokens !== null && usedTokens !== null && usedTokens >= input.autoCompactTokens) {
          const ack = yield* host.command<SessionCompactResult>("session/compact", { sessionId }).pipe(
            Effect.map((result) => result.status),
            Effect.catch((error) => Effect.logWarning("session/compact failed", error.message).pipe(Effect.as(null))),
          )
          if (ack === "accepted") requestedCompaction.trigger = "auto"
        }
        if (requestedCompaction.trigger !== null) {
          yield* Queue.take(inbox).pipe(
            Effect.flatMap(handle),
            Effect.repeat({ while: () => requestedCompaction.trigger !== null }),
          )
        }
        if (compacting) return yield* emit({ type: "turn_completed" })

        // MSP has no developer instructions, so hinacode's ride in front of the prompt.
        const prompt = yield* promptParts(host, sessionId, input.prompt, input.attachments, input.instructions)
        run.turnStart = yield* host
          .command<TurnStartResult>("turn/start", {
            sessionId,
            // Muse shows `displayText`, never the instructions in front of the prompt.
            input: prompt,
            displayText: input.prompt,
            ...(input.effort === null ? {} : { reasoningEffort: input.effort }),
          })
          .pipe(
            Effect.map((ack) => ack.turnId),
            Effect.mapError(toAgentError),
            Effect.forkIn(providerScope),
          )
        run.turnId = yield* Fiber.join(run.turnStart)
        // Muse steered or queued the prompt behind a turn it started by itself that the runner had not adopted yet.
        // This run follows the session until its own turn completes, so it shows that turn instead of the wake.
        wakeTurns.delete(sessionId)

        while (!(yield* Queue.take(inbox).pipe(Effect.flatMap(handle)))) {}
      }),
    )

  /** Interrupts the remote turn once Muse has one; before that, or if Muse does not answer, ends the run locally. */
  const interrupt = (threadId: string) =>
    Effect.suspend(() => {
      const run = runs.get(threadId)
      if (!run) return Effect.void
      const stop = Deferred.succeed(run.stop, undefined)
      return run.turnId && run.entry && run.sessionId
        ? interruptTurn(run.entry.host, run.sessionId, run.turnId).pipe(Effect.catch(() => stop))
        : stop
    }).pipe(Effect.asVoid)

  const closeSession = (threadId: string) =>
    Effect.gen(function* () {
      const sessionId = threadSessions.get(threadId)
      if (sessionId === undefined) return
      const entry = current
      if (entry?.host.isAlive()) yield* leaveSession(entry.host, sessionId)
      if (entry !== undefined) {
        setBackgroundTasks(entry, sessionId, [])
        entry.sessions.delete(sessionId)
      }
      threadSessions.delete(threadId)
      grants.delete(threadId)
    })

  const steer = (threadId: string, text: string, attachments: ReadonlyArray<Attachment>) =>
    Effect.gen(function* () {
      const run = runs.get(threadId)
      const { entry, sessionId, turnId } = run ?? {}
      if (!entry?.host.isAlive() || !sessionId || !turnId) return yield* museError("No turn is running on this thread")
      // Muse 1.4.7 rejects skill parts on turn/steer; only turn/start expands them.
      const input = yield* userInput(text, attachments)
      yield* entry.host
        .command("turn/steer", { sessionId, expectedTurnId: turnId, input })
        .pipe(Effect.mapError(toAgentError))
    })

  /** Muse switches a loaded session's permission profile at once, so a running turn takes the new profile. */
  const setAccessMode = (threadId: string, accessMode: AccessMode) =>
    Effect.gen(function* () {
      const run = runs.get(threadId)
      const loaded = run?.sessionId === undefined ? undefined : run.entry?.sessions.get(run.sessionId)
      if (!run?.entry || !run.sessionId || !loaded) return
      const profileId = permissionProfiles[accessMode]
      yield* run.entry.host
        .command("session/setPermissionProfile", { sessionId: run.sessionId, profileId })
        .pipe(Effect.mapError(toAgentError))
      loaded.permissionProfile = profileId
    })

  /** A background task's id is its `toolCall` item's id. The ended call's `item/completed` drops it from the set. */
  const stopBackgroundTask = (threadId: string, taskId: string) =>
    Effect.gen(function* () {
      const sessionId = threadSessions.get(threadId)
      if (!current?.host.isAlive() || sessionId === undefined) return
      const { host, backgroundTasks } = current
      const tasks = backgroundTasks.get(sessionId) ?? []
      yield* host.command("task/stop", { sessionId, taskId }).pipe(
        // Muse 1.4.12 refuses `task/stop` with `invalid_target` for a shell it backgrounded past its yield time,
        // though `task/stopAll` reaches it. Stopping all is only the same thing when it is the one task.
        Effect.catch((error) =>
          tasks.length === 1 && tasks[0]!.id === taskId
            ? host.command("task/stopAll", { sessionId })
            : Effect.fail(error),
        ),
        Effect.mapError(toAgentError),
      )
    })

  /** A sub-agent's id is its durable MSP `subagentId`, which `subagent/stop` names on the parent session. */
  const stopSubagent = (threadId: string, subagentId: string) =>
    Effect.gen(function* () {
      const sessionId = threadSessions.get(threadId)
      if (!current?.host.isAlive() || sessionId === undefined) {
        return yield* museError("The sub-agent has no active session to stop")
      }
      yield* current.host.command("subagent/stop", { sessionId, subagentId }).pipe(Effect.mapError(toAgentError))
    })

  const respondApproval = (requestId: string, decision: ApprovalDecision) =>
    Effect.suspend(() => {
      const deferred = approvals.get(requestId)
      return deferred ? Deferred.succeed(deferred, decision) : Effect.void
    }).pipe(Effect.asVoid)

  const respondQuestion = (requestId: string, answers: QuestionAnswers) =>
    Effect.suspend(() => {
      const deferred = questions.get(requestId)
      return deferred ? Deferred.succeed(deferred, answers) : Effect.void
    }).pipe(Effect.asVoid)

  return {
    id: "muse",
    listModels,
    account,
    planLimits,
    usage,
    listCommands,
    runTurn,
    steer,
    wakes: Stream.fromQueue(wakes),
    interrupt,
    closeSession,
    backgroundTasks: { changes: Stream.fromQueue(backgroundTaskChanges), stop: stopBackgroundTask },
    stopSubagent,
    respondApproval,
    respondQuestion,
    setAccessMode,
  } satisfies AgentProvider
})

export class MuseProvider extends Context.Service<MuseProvider, AgentProvider>()("hinacode/MuseProvider") {
  static readonly layer = Layer.effect(MuseProvider, make)
}
