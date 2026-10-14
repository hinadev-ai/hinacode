import { randomUUID } from "node:crypto"
import { readFile } from "node:fs/promises"
import { Context, Deferred, Effect, Exit, Fiber, Layer, Option, Queue, Schema, Scope, Semaphore, Stream } from "effect"
import type {
  AccountHome,
  AgentEvent,
  ApprovalDecision,
  ContextWindow,
  QuestionAnswers,
  RunTurnInput,
  SessionScope,
} from "../../../shared/agent.ts"
import type { AccessMode, Attachment } from "../../../shared/domain.ts"
import { resolveBinary } from "../binary.ts"
import { elementContext } from "../elementContext.ts"
import { AgentError, type AgentProvider } from "../provider.ts"
import { choiceFor, sessionScope, toApprovalRequest } from "./approvals.ts"
import { toAccount, toModelInfo } from "./catalog.ts"
import { type Incoming, makeMuseHost, type MuseHost, toAgentError } from "./host.ts"
import { editedPath, toolInput, toolName, toolResult } from "./items.ts"
import { toPlanLimits } from "./limits.ts"
import {
  AccountState,
  type ApprovalMode,
  type ApprovalRequestParams,
  type ApprovalResolvedParams,
  type ApprovalUpdatedParams,
  type Item,
  type ItemCompletedParams,
  type ItemDeltaParams,
  type ItemStartedParams,
  ModelList,
  type SessionContextUsageParams,
  type SessionResumeResult,
  type SessionStartResult,
  SkillList,
  SubscriptionUsage,
  type TurnCompletedParams,
  type TurnInputPart,
  type TurnStartResult,
  type UserInputRequestParams,
  type UserInputSettledParams,
  ViewPage,
} from "./protocol.ts"
import { toAnswers, toQuestion } from "./questions.ts"
import { parseSkillInvocation, toCommand } from "./skills.ts"
import { makeSessionUsage } from "./usage.ts"

const CLIENT_VERSION = "0.1.0"

/**
 * Muse's OS sandbox stays on with the network open. Under the default `proxy-only`, `allowAll` silently blocks every
 * connection, so Full access could not reach the network. The posture is fixed per host and a loaded session cannot
 * move to another host, so every thread shares it. `--trust-workspace` loads the project's skills and rules, since
 * importing a project trusts it.
 */
const HOST_ARGS = ["serve", "--trust-workspace", "--sandbox-network", "enabled"]

const approvalModes: Record<AccessMode, ApprovalMode> = {
  supervised: "promptUnmatched",
  auto: "onRequest",
  full: "allowAll",
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
  approvalMode: ApprovalMode | null
  cwd: string
}

interface HostEntry {
  readonly host: MuseHost
  readonly scope: Scope.Closeable
  /** A session stays loaded in the host that opened it; another host gets `sessionInUse` until this one exits. */
  readonly sessions: Map<string, LoadedSession>
}

/** A turn on one kkcode thread, from the moment it is asked for until its stream ends. */
type Run = {
  /** Completed by Stop when there is no started remote turn to interrupt. */
  readonly stop: Deferred.Deferred<void>
  entry?: HostEntry
  sessionId?: string
  /** Outlives a stopped run, so a turn Muse starts after Stop can still be interrupted. */
  turnStart?: Fiber.Fiber<string, AgentError>
  turnId?: string
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
      Effect.map((data): Array<TurnInputPart> => [
        { type: "image", base64Data: data.toString("base64"), mediaType: attachment.mime },
        ...(attachment.element ? [textPart(elementContext(attachment.element))] : []),
      ]),
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
 * The parts one prompt goes in as, kkcode's instructions first. A prompt typed as `/skill arguments`
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

const interruptTurn = (host: MuseHost, sessionId: string, turnId: string) =>
  Effect.suspend(() =>
    host.isAlive()
      ? host.command("turn/interrupt", { sessionId, turnId }).pipe(Effect.mapError(toAgentError))
      : Effect.void,
  )

const make = Effect.gen(function* () {
  const providerScope = yield* Effect.scope
  const binaryPath = resolveBinary("muse")
  const hostLock = yield* Semaphore.make(1)
  let current: HostEntry | undefined
  /** The plan usage the host last reported. A fresh host has none until it makes a model call. */
  let planUsage: SubscriptionUsage | undefined
  const decodePlanUsage = Schema.decodeUnknownOption(SubscriptionUsage)

  /** Spawned on first use and respawned after it dies, like Codex's app-server. */
  const getEntry = (home: AccountHome | null) =>
    Semaphore.withPermit(
      hostLock,
      Effect.gen(function* () {
        // An added account is a home directory, and Muse has none of its own, so it only runs on its CLI login.
        if (home !== null) return yield* museError("Muse Code runs on its CLI login only")
        if (current?.host.isAlive()) return current
        if (current) yield* Scope.close(current.scope, Exit.void)
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
        yield* host
          .subscribe((message) => {
            if (message.kind !== "notification" || message.method !== "usage/changed") return
            planUsage = Option.getOrElse(decodePlanUsage(message.params), () => planUsage)
          })
          .pipe(Scope.provide(scope))
        current = { host, scope, sessions: new Map() }
        return current
      }),
    )
  yield* Effect.addFinalizer(() => (current ? Scope.close(current.scope, Exit.void) : Effect.void))

  const getHost = (home: AccountHome | null) => getEntry(home).pipe(Effect.map((entry) => entry.host))

  /** Pending approvals keyed by the kkcode approval id handed to the UI. */
  const approvals = new Map<string, Deferred.Deferred<ApprovalDecision>>()
  /** Pending questions keyed by the kkcode question id handed to the UI. */
  const questions = new Map<string, Deferred.Deferred<QuestionAnswers>>()
  /** Each thread's Muse session, so `skill/list` can ask the session a turn would run in. */
  const threadSessions = new Map<string, string>()
  /**
   * One throwaway session per workspace, started only to read its `skill/list` before the thread's first
   * turn. It never runs a turn, and a respawned host resumes it instead of starting another.
   */
  const probeSessions = new Map<string, string>()
  const probeLock = yield* Semaphore.make(1)
  /** In-flight runs keyed by kkcode threadId, for steer, interrupt and access mode changes. */
  const runs = new Map<string, Run>()
  /** "Allow for session" grants keyed by kkcode threadId. They last until kkcode quits. */
  const grants = new Map<string, Set<string>>()

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
            sessions.set(known, { model: resumed.modelId, approvalMode: resumed.approvalMode?.mode ?? null, cwd })
            return known
          }
        }
        const { session } = yield* host
          .command<SessionStartResult>("session/start", { workspaceRoot: cwd })
          .pipe(Effect.mapError(toAgentError))
        sessions.set(session.sessionId, { model: session.modelId ?? null, approvalMode: null, cwd })
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
      return skills.map(toCommand)
    })

  /** Starts the thread's session or loads it into the host, then brings its model and approval mode up to date. */
  const openSession = (entry: HostEntry, input: RunTurnInput) =>
    Effect.gen(function* () {
      const { host, sessions } = entry
      const approvalMode = approvalModes[input.accessMode]
      // Each session carries its own thread's credential for the kkcode MCP server.
      const config = {
        mcpServers: {
          kkcode: { transport: "streamableHttp", url: input.mcpServer.url, headers: { ...input.mcpServer.headers } },
        },
      }
      if (input.resumeSessionId === null) {
        const { session } = yield* host.command<SessionStartResult>("session/start", {
          workspaceRoot: input.cwd,
          modelId: input.model,
          approvalMode,
          config,
        })
        sessions.set(session.sessionId, { model: input.model, approvalMode, cwd: input.cwd })
        threadSessions.set(input.threadId, session.sessionId)
        return session.sessionId
      }
      const sessionId = input.resumeSessionId
      let loaded = sessions.get(sessionId)
      if (loaded === undefined) {
        const { session } = yield* host.command<SessionResumeResult>("session/resume", {
          sessionId,
          excludeItems: true,
          config,
        })
        loaded = { model: session.modelId, approvalMode: session.approvalMode?.mode ?? null, cwd: input.cwd }
        sessions.set(sessionId, loaded)
      }
      threadSessions.set(input.threadId, sessionId)
      if (loaded.model !== input.model) {
        yield* host.command("session/setModel", { sessionId, model: { modelId: input.model } })
        loaded.model = input.model
      }
      if (loaded.approvalMode !== approvalMode) {
        yield* host.command("session/setApprovalMode", { sessionId, mode: approvalMode })
        loaded.approvalMode = approvalMode
      }
      return sessionId
    }).pipe(Effect.mapError(toAgentError))

  const runTurn = (input: RunTurnInput): Stream.Stream<AgentEvent, AgentError> =>
    Stream.callback<AgentEvent, AgentError>((out) =>
      Effect.gen(function* () {
        const emit = (event: AgentEvent) => Queue.offer(out, event)
        const run: Run = { stop: yield* Deferred.make<void>() }
        runs.set(input.threadId, run)
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => runs.get(input.threadId) === run && runs.delete(input.threadId)),
        )

        const stream = Effect.gen(function* () {
          const entry = yield* getEntry(input.home)
          const { host } = entry
          run.entry = entry

          // Subscribe before starting so no notification is missed; they wait here until the turn id is known.
          const inbox = yield* Queue.unbounded<Incoming>()
          yield* host.subscribe((message) => Queue.offerUnsafe(inbox, message))

          const sessionId = yield* openSession(entry, input)
          run.sessionId = sessionId
          yield* emit({ type: "session_bound", providerSessionId: sessionId })

          // MSP has no developer instructions, so kkcode's ride in front of the prompt.
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
          const turnId = yield* Fiber.join(run.turnStart)
          run.turnId = turnId

          const threadGrants = grants.get(input.threadId) ?? new Set<string>()
          grants.set(input.threadId, threadGrants)
          const pendingApprovals = new Map<string, Approval>()
          const pendingQuestions = new Map<string, { readonly id: string; readonly params: UserInputRequestParams }>()
          /** Text already shown per streamed item, so `item/completed` adds only what never arrived as a delta. */
          const shown = new Map<string, string>()
          /** The reasoning summary part each item streamed last. */
          const summaryParts = new Map<string, string>()
          const toolOutput = new Map<string, string>()
          const openTools = new Set<string>()
          let context: ContextWindow | undefined

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
                yield* host
                  .command("userInput/cancel", { sessionId, userInputId: params.userInputId })
                  .pipe(Effect.ignore)
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
                request: toApprovalRequest(params, approval.id, input.threadId),
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
                  threadId: input.threadId,
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

          const finishTool = (item: Item) =>
            Effect.gen(function* () {
              if (item.tool === undefined) return
              yield* startTool(item)
              openTools.delete(item.itemId)
              yield* emit({
                type: "tool_call_finished",
                callId: item.itemId,
                ...toolResult(item, toolOutput.get(item.itemId)),
              })
              toolOutput.delete(item.itemId)
              const path = editedPath(item, input.cwd)
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

          const onCompleted = (item: Item) => {
            switch (item.kind) {
              case "agentMessage":
                return finishText(item, "text_delta", item.text ?? "")
              case "reasoning":
                summaryParts.delete(item.itemId)
                return finishText(item, "reasoning_delta", (item.summary ?? []).join(SUMMARY_BREAK))
              case "toolCall":
                return finishTool(item)
              default:
                return Effect.void
            }
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
              if (quota !== undefined) {
                return yield* emit({
                  type: "turn_limited",
                  limit: {
                    kind: "usage",
                    message: params.error?.message ?? "Muse Code usage limit reached",
                    reset: { at: new Date(quota.resetsAtMs).toISOString(), autoResume: false },
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
                case "session/contextUsage": {
                  const { usedTokens, windowTokens } = message.params as SessionContextUsageParams
                  if (windowTokens !== undefined) context = { usedTokens, maxTokens: windowTokens }
                  return false
                }
                case "turn/completed": {
                  const params = message.params as TurnCompletedParams
                  if (params.turnId !== turnId) return false
                  yield* finishTurn(params)
                  return true
                }
                default:
                  return false
              }
            })

          while (!(yield* Queue.take(inbox).pipe(Effect.flatMap(handle)))) {}
        })

        const stopped = yield* Effect.raceFirst(
          stream.pipe(Effect.as(false)),
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

  const steer = (threadId: string, text: string, attachments: ReadonlyArray<Attachment>) =>
    Effect.gen(function* () {
      const run = runs.get(threadId)
      const { entry, sessionId, turnId } = run ?? {}
      if (!entry?.host.isAlive() || !sessionId || !turnId) return yield* museError("No turn is running on this thread")
      const input = yield* promptParts(entry.host, sessionId, text, attachments, null)
      yield* entry.host
        .command("turn/steer", { sessionId, expectedTurnId: turnId, input })
        .pipe(Effect.mapError(toAgentError))
    })

  /** Muse switches a loaded session's approval mode at once, so a running turn takes the new mode. */
  const setAccessMode = (threadId: string, accessMode: AccessMode) =>
    Effect.gen(function* () {
      const run = runs.get(threadId)
      const loaded = run?.sessionId === undefined ? undefined : run.entry?.sessions.get(run.sessionId)
      if (!run?.entry || !run.sessionId || !loaded) return
      const mode = approvalModes[accessMode]
      yield* run.entry.host
        .command("session/setApprovalMode", { sessionId: run.sessionId, mode })
        .pipe(Effect.mapError(toAgentError))
      loaded.approvalMode = mode
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
    interrupt,
    respondApproval,
    respondQuestion,
    setAccessMode,
  } satisfies AgentProvider
})

export class MuseProvider extends Context.Service<MuseProvider, AgentProvider>()("kkcode/MuseProvider") {
  static readonly layer = Layer.effect(MuseProvider, make)
}
