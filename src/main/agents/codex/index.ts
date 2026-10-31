import { randomUUID } from "node:crypto"
import {
  Context,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  Layer,
  Queue,
  Schema,
  Scope,
  Semaphore,
  Stream,
} from "effect"
import type {
  AccountHome,
  AgentAccount,
  AgentCommand,
  AgentEvent,
  ApprovalDecision,
  BackgroundTask,
  ModelInfo,
  Question,
  QuestionAnswers,
  RunTurnInput,
  Subagent,
  TokenUsage,
} from "../../../shared/agent.ts"
import type { Attachment } from "../../../shared/domain.ts"
import type { LimitWindow, PlanLimits } from "../../../shared/limits.ts"
import { nowIso } from "../../services/clock.ts"
import { installedBinary } from "../binary.ts"
import { COMPACT_COMMAND, isCompactCommand } from "../compact.ts"
import {
  AgentError,
  type AgentProvider,
  type BackgroundTasksChange,
  LISTED_SESSIONS,
  type SessionHistory,
} from "../provider.ts"
import { perHome } from "../usage.ts"
import { threadAccess, turnAccess } from "./access.ts"
import { type CodexClient, type Incoming, makeCodexClient } from "./client.ts"
import { codexHome, copyRollouts, makeRolloutUsage } from "./rollouts.ts"
import { attachmentContext } from "../elementContext.ts"
import { applyChildNotification, applyParentItem, type Subagents } from "./subagents.ts"
import { toolInput, toolName, toolResult, toPostedQuestion } from "./items.ts"
import { toImportedHistory, toNativeSessions } from "./sessions.ts"
import {
  GetAccountRateLimitsResponse,
  GetAccountResponse,
  type RateLimitWindow,
  ThreadBackgroundTerminalsListResponse,
  ThreadListResponse,
  ThreadReadResponse,
  ThreadTurnsListResponse,
} from "./protocol.ts"
import type {
  HistoryTurn,
  ApprovalDecisionWire,
  ElicitationActionWire,
  GetAccountParams,
  McpServerElicitationRequestParams,
  ModelListParams,
  ModelListResponse,
  PlanType,
  ServerNotificationParams,
  ServerRequestParams,
  SkillMetadata,
  SkillScope,
  SkillsListParams,
  SkillsListResponse,
  ThreadItem,
  ThreadForkParams,
  ThreadForkResponse,
  ThreadResumeParams,
  ThreadStartParams,
  ThreadStartResponse,
  TurnInterruptParams,
  TurnStartParams,
  TurnStartResponse,
  ToolRequestUserInputParams,
  ToolRequestUserInputQuestion,
  ToolRequestUserInputResponse,
  ThreadBackgroundTerminalsListParams,
  ThreadBackgroundTerminalsTerminateParams,
  TurnSteerParams,
  ThreadCompactStartParams,
  UserInput,
} from "./protocol.ts"

const CLIENT_VERSION = "0.1.0"

const FAST_SERVICE_TIER = "priority"

const decisionToWire: Record<ApprovalDecision, ApprovalDecisionWire> = {
  allow: "accept",
  allow_for_session: "acceptForSession",
  deny: "decline",
}

const toQuestion = (question: ToolRequestUserInputQuestion): Question => ({
  id: question.id,
  header: question.header,
  question: question.question,
  options: question.options ?? [],
  multiSelect: false,
  allowsText: question.isOther || question.options === null || question.options.length === 0,
  secret: question.isSecret,
})

const userInputResponse = (answers: QuestionAnswers): ToolRequestUserInputResponse => ({
  answers: Object.fromEntries(Object.entries(answers).map(([id, values]) => [id, { answers: [...values] }])),
})

const textInput = (text: string): UserInput => ({ type: "text", text, text_elements: [] })

const userInput = (text: string, attachments: ReadonlyArray<Attachment>): Array<UserInput> => [
  ...(text === "" ? [] : [textInput(text)]),
  ...attachments.flatMap((attachment): Array<UserInput> => {
    if (attachment.kind !== "image") return [textInput(`Attached file: ${attachment.path}`)]
    const image: UserInput = { type: "localImage", path: attachment.path }
    const context = attachmentContext(attachment)
    return context === null ? [image] : [image, textInput(context)]
  }),
]

const commandScopes: Partial<Record<SkillScope, AgentCommand["scope"]>> = { user: "user", repo: "project" }

// FIXME: Codex expands a skill only when it arrives as its own input item next to the $name in the text
const skillInputs = (text: string, skills: ReadonlyArray<SkillMetadata>): Array<UserInput> =>
  skills
    .filter((skill) => skill.enabled && text.includes(`$${skill.name}`))
    .map((skill) => ({ type: "skill", name: skill.name, path: skill.path }))

type RemoteTurn = { readonly threadId: string; readonly turnId: string }

type Run = {
  readonly stop: Deferred.Deferred<void>
  client?: CodexClient
  turnStart?: Fiber.Fiber<RemoteTurn, AgentError>
  turn?: RemoteTurn
}

const interruptTurn = (client: CodexClient, turn: RemoteTurn) =>
  Effect.suspend(() =>
    client.isAlive() ? client.request("turn/interrupt", turn satisfies TurnInterruptParams) : Effect.void,
  )

const copySession = (threadId: string, from: AccountHome | null, to: AccountHome | null) =>
  Effect.tryPromise({
    try: () => copyRollouts(threadId, from?.dir ?? codexHome(), to?.dir ?? codexHome()),
    catch: (cause) => new AgentError({ provider: "codex", message: `Failed to copy Codex rollouts: ${String(cause)}` }),
  }).pipe(
    Effect.flatMap((copied) =>
      copied
        ? Effect.void
        : Effect.fail(
            new AgentError({ provider: "codex", message: "No Codex rollout for this thread in the old account" }),
          ),
    ),
  )

const interruptedEvent: AgentEvent = { type: "turn_failed", message: "Turn interrupted" }

// FIXME: Codex has no notification for background terminals
const TERMINAL_POLL_INTERVAL = Duration.seconds(2)

type Terminals = {
  readonly client: CodexClient
  readonly codexThreadId: string
  tasks: ReadonlyArray<BackgroundTask>
  poll?: Fiber.Fiber<void>
}

const sameTasks = (a: ReadonlyArray<BackgroundTask>, b: ReadonlyArray<BackgroundTask>) =>
  a.length === b.length && a.every((task, index) => task.id === b[index]?.id)

const make = Effect.gen(function* () {
  const providerScope = yield* Effect.scope
  const clientLock = yield* Semaphore.make(1)
  const clients = new Map<string, { readonly client: CodexClient; readonly scope: Scope.Closeable }>()

  const getClient = (home: AccountHome | null) =>
    Semaphore.withPermit(
      clientLock,
      Effect.gen(function* () {
        const key = JSON.stringify(home)
        const current = clients.get(key)
        if (current?.client.isAlive()) return current.client
        if (current) yield* Scope.close(current.scope, Exit.void)
        const binaryPath = yield* installedBinary("codex", home?.binary ?? "codex")
        const scope = yield* Scope.make()
        const env = home === null ? { ...process.env } : { ...process.env, CODEX_HOME: home.dir }
        const client = yield* makeCodexClient({
          binaryPath,
          clientVersion: CLIENT_VERSION,
          env,
        }).pipe(
          Scope.provide(scope),
          Effect.onError(() => Scope.close(scope, Exit.void)),
        )
        clients.set(key, { client, scope })
        return client
      }),
    )
  yield* Effect.addFinalizer(() =>
    Effect.forEach(clients.values(), ({ scope }) => Scope.close(scope, Exit.void), { discard: true }),
  )

  const approvals = new Map<string, Deferred.Deferred<ApprovalDecision>>()
  const questions = new Map<string, Deferred.Deferred<QuestionAnswers>>()
  const runs = new Map<string, Run>()
  const subagentsByThread = new Map<string, Subagents>()
  const subagentTurns = new Map<string, string>()
  const loadedCompactLimits = new Map<string, number | null>()
  const terminalsByThread = new Map<string, Terminals>()
  const backgroundTaskChanges = yield* Queue.unbounded<BackgroundTasksChange>()

  const listTerminals = (terminals: Terminals) =>
    Effect.gen(function* () {
      const found: ThreadBackgroundTerminalsListResponse["data"][number][] = []
      let cursor: string | null = null
      do {
        const params: ThreadBackgroundTerminalsListParams = { threadId: terminals.codexThreadId, cursor, limit: 100 }
        const raw = yield* terminals.client.request<unknown>("thread/backgroundTerminals/list", params)
        const page: ThreadBackgroundTerminalsListResponse = yield* Schema.decodeUnknownEffect(
          ThreadBackgroundTerminalsListResponse,
        )(raw)
        found.push(...page.data)
        cursor = page.nextCursor
      } while (cursor)
      return found
    })

  const refreshTerminals = (threadId: string, terminals: Terminals) =>
    Effect.gen(function* () {
      const listed = yield* listTerminals(terminals).pipe(Effect.orElseSucceed(() => []))
      const now = yield* nowIso
      const tasks = listed.map((terminal): BackgroundTask => ({
        id: terminal.processId,
        kind: "shell",
        label: terminal.command,
        startedAt: terminals.tasks.find((task) => task.id === terminal.processId)?.startedAt ?? now,
      }))
      if (sameTasks(terminals.tasks, tasks)) return tasks
      terminals.tasks = tasks
      yield* Queue.offer(backgroundTaskChanges, { threadId, tasks })
      return tasks
    })

  const watchTerminals = (threadId: string, client: CodexClient, codexThreadId: string) =>
    Effect.gen(function* () {
      const current = terminalsByThread.get(threadId)
      if (current?.client === client && current.codexThreadId === codexThreadId) return
      if (current?.poll) yield* Fiber.interrupt(current.poll)
      const terminals: Terminals = { client, codexThreadId, tasks: current?.tasks ?? [] }
      terminalsByThread.set(threadId, terminals)
      terminals.poll = yield* Effect.gen(function* () {
        while (true) {
          yield* Effect.sleep(TERMINAL_POLL_INTERVAL)
          const tasks = yield* refreshTerminals(threadId, terminals)
          if (tasks.length === 0 && !runs.has(threadId)) return
        }
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => terminalsByThread.get(threadId) === terminals && terminalsByThread.delete(threadId)),
        ),
        Effect.forkIn(providerScope),
      )
    })

  const stopBackgroundTask = (threadId: string, taskId: string) =>
    Effect.suspend(() => {
      const terminals = terminalsByThread.get(threadId)
      if (terminals === undefined) return Effect.void
      const params: ThreadBackgroundTerminalsTerminateParams = {
        threadId: terminals.codexThreadId,
        processId: taskId,
      }
      return terminals.client
        .request("thread/backgroundTerminals/terminate", params)
        .pipe(Effect.andThen(refreshTerminals(threadId, terminals)), Effect.asVoid)
    })

  const stopSubagents = (threadId: string, home: AccountHome | null) =>
    Effect.gen(function* () {
      const subagents = subagentsByThread.get(threadId)
      if (subagents === undefined) return
      subagentsByThread.delete(threadId)
      const client = clients.get(JSON.stringify(home))?.client
      for (const [childThreadId, subagent] of subagents) {
        const turnId = subagentTurns.get(childThreadId)
        subagentTurns.delete(childThreadId)
        if (client === undefined || turnId === undefined || subagent.status !== "running") continue
        yield* interruptTurn(client, { threadId: childThreadId, turnId }).pipe(Effect.ignore)
      }
    })

  const closeSession = (threadId: string, home: AccountHome | null) =>
    Effect.gen(function* () {
      yield* stopSubagents(threadId, home)
      const terminals = terminalsByThread.get(threadId)
      if (terminals === undefined) return
      if (terminals.poll) yield* Fiber.interrupt(terminals.poll)
      const listed = yield* listTerminals(terminals).pipe(Effect.orElseSucceed(() => []))
      yield* Effect.forEach(
        listed,
        ({ processId }) => {
          const params: ThreadBackgroundTerminalsTerminateParams = { threadId: terminals.codexThreadId, processId }
          return terminals.client.request("thread/backgroundTerminals/terminate", params).pipe(Effect.ignore)
        },
        { discard: true },
      )
      yield* refreshTerminals(threadId, terminals)
    })

  const listModels = Effect.gen(function* () {
    const client = yield* getClient(null)
    const models: Array<ModelInfo> = []
    let cursor: string | null = null
    do {
      const params: ModelListParams = { cursor, limit: 100, includeHidden: false }
      const page: ModelListResponse = yield* client.request<ModelListResponse>("model/list", params)
      for (const model of page.data) {
        models.push({
          id: model.id,
          label: model.displayName,
          provider: "codex",
          efforts: model.supportedReasoningEfforts.map((option) => option.reasoningEffort),
          defaultEffort: model.defaultReasoningEffort,
          fastMode: model.serviceTiers.some((tier) => tier.id === FAST_SERVICE_TIER),
          autoMode: true,
        })
      }
      cursor = page.nextCursor
    } while (cursor)
    return models
  })

  const planLimits = (home: AccountHome | null) =>
    Effect.gen(function* () {
      const client = yield* getClient(home)
      const raw = yield* client.request<unknown>("account/rateLimits/read", undefined)
      const response = yield* Schema.decodeUnknownEffect(GetAccountRateLimitsResponse)(raw).pipe(
        Effect.mapError(
          () => new AgentError({ provider: "codex", message: "Failed to read Codex plan limits: invalid response" }),
        ),
      )
      return toPlanLimits(response, yield* nowIso)
    })

  const rolloutUsage = perHome(makeRolloutUsage)
  const readUsage = (threadId: string, home: AccountHome | null) =>
    Effect.tryPromise({
      try: () => rolloutUsage(home?.dir ?? codexHome())(threadId),
      catch: (cause) =>
        new AgentError({ provider: "codex", message: `Failed to read Codex rollouts: ${String(cause)}` }),
    })

  const invalidResponse = (what: string) => () =>
    new AgentError({ provider: "codex", message: `Failed to ${what}: invalid response` })

  const listSessions = (cwd: string, home: AccountHome | null) =>
    Effect.gen(function* () {
      const client = yield* getClient(home)
      const raw = yield* client.request<unknown>("thread/list", {
        cwd,
        limit: LISTED_SESSIONS,
        sortKey: "updated_at",
        sourceKinds: ["cli", "vscode", "exec", "appServer"],
      })
      const response = yield* Schema.decodeUnknownEffect(ThreadListResponse)(raw).pipe(
        Effect.mapError(invalidResponse("list Codex sessions")),
      )
      return toNativeSessions(response, cwd)
    })

  const listTurns = (client: CodexClient, threadId: string) =>
    Effect.gen(function* () {
      const turns: Array<HistoryTurn> = []
      let cursor: string | null = null
      do {
        const raw = yield* client.request<unknown>("thread/turns/list", {
          threadId,
          cursor,
          itemsView: "full",
          sortDirection: "asc",
        })
        const page: typeof ThreadTurnsListResponse.Type =
          yield* Schema.decodeUnknownEffect(ThreadTurnsListResponse)(raw)
        turns.push(...page.data)
        cursor = page.nextCursor
      } while (cursor)
      return turns
    })

  const readSession = (sessionId: string, cwd: string, home: AccountHome | null) =>
    Effect.gen(function* () {
      const client = yield* getClient(home)
      const read = yield* client.request<unknown>("thread/read", { threadId: sessionId, includeTurns: false }).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(ThreadReadResponse)),
        Effect.mapError(
          () => new AgentError({ provider: "codex", message: `Codex session ${sessionId} is no longer there` }),
        ),
      )
      if (read.thread.cwd !== cwd) {
        return yield* new AgentError({ provider: "codex", message: `Codex session ${sessionId} ran in another folder` })
      }
      return yield* listTurns(client, sessionId).pipe(
        Effect.map((turns) => toImportedHistory(read, turns)),
        Effect.orElseSucceed((): SessionHistory => ({
          title: read.thread.name,
          model: read.thread.model,
          messages: null,
        })),
      )
    })

  const account = (home: AccountHome | null) =>
    Effect.gen(function* () {
      const client = yield* getClient(home)
      const params: GetAccountParams = { refreshToken: false }
      const raw = yield* client.request<unknown>("account/read", params)
      const response = yield* Schema.decodeUnknownEffect(GetAccountResponse)(raw).pipe(
        Effect.mapError(
          () => new AgentError({ provider: "codex", message: "Failed to read the Codex account: invalid response" }),
        ),
      )
      return toAccount(response.account)
    })

  const listSkills = (cwd: string, home: AccountHome | null) =>
    Effect.gen(function* () {
      const client = yield* getClient(home)
      const params: SkillsListParams = { cwds: [cwd] }
      const response = yield* client.request<SkillsListResponse>("skills/list", params)
      return response.data.flatMap((entry) => entry.skills)
    })

  const listCommands = ({ cwd, home }: { readonly cwd: string; readonly home: AccountHome | null }) =>
    listSkills(cwd, home).pipe(
      Effect.map((skills) => [
        COMPACT_COMMAND,
        ...skills
          .filter((skill) => skill.enabled)
          .map((skill): AgentCommand => {
            const scope = commandScopes[skill.scope]
            return {
              trigger: "$",
              name: skill.name,
              description: skill.shortDescription ?? skill.description,
              argumentHint: "",
              ...(scope && { scope }),
            }
          }),
      ]),
    )

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
          const client = yield* getClient(input.home)
          run.client = client

          const inbox = yield* Queue.unbounded<Incoming>()
          yield* client.subscribe((message) => Queue.offerUnsafe(inbox, message))

          const hiddenSkills = input.userSkills
            ? null
            : (yield* listSkills(input.cwd, input.home)).filter((skill) => skill.scope === "user")
          const overrides = {
            cwd: input.cwd,
            model: input.model,
            ...threadAccess(input.accessMode),
            config: {
              tools: { update_plan: { enabled: true } },
              ...(input.autoCompactTokens !== null && { model_auto_compact_token_limit: input.autoCompactTokens }),
              ...(hiddenSkills !== null && {
                skills: { config: hiddenSkills.map((skill) => ({ path: skill.path, enabled: false })) },
              }),
              mcp_servers: {
                hinacode: { url: input.mcpServer.url, http_headers: input.mcpServer.headers, tool_timeout_sec: 600 },
              },
            },
            developerInstructions: input.instructions,
          } satisfies ThreadStartParams
          const resumed = input.resumeSessionId
          const loadedLimit = resumed === null ? undefined : loadedCompactLimits.get(resumed)
          if (resumed !== null && loadedLimit !== undefined && loadedLimit !== input.autoCompactTokens) {
            // FIXME: Codex ignores thread/resume config for a thread it has loaded
            yield* client.request("thread/unsubscribe", { threadId: resumed })
          }
          const { thread, sandbox } =
            input.resumeSessionId === null
              ? yield* client.request<ThreadStartResponse>("thread/start", overrides)
              : input.forkAt === null
                ? yield* client.request<ThreadStartResponse>("thread/resume", {
                    ...overrides,
                    threadId: input.resumeSessionId,
                    excludeTurns: true,
                  } satisfies ThreadResumeParams)
                : yield* client.request<ThreadForkResponse>("thread/fork", {
                    ...overrides,
                    threadId: input.resumeSessionId,
                    lastTurnId: input.forkAt,
                    excludeTurns: true,
                  } satisfies ThreadForkParams)
          loadedCompactLimits.set(thread.id, input.autoCompactTokens)
          yield* emit({ type: "session_bound", providerSessionId: thread.id })

          const compacting = isCompactCommand(input.prompt)
          const startTurn = Effect.gen(function* () {
            const skills = input.prompt.includes("$")
              ? (yield* listSkills(input.cwd, input.home)).filter((skill) => input.userSkills || skill.scope !== "user")
              : []
            const turnStart: TurnStartParams = {
              threadId: thread.id,
              input: [...userInput(input.prompt, input.attachments), ...skillInputs(input.prompt, skills)],
              cwd: input.cwd,
              ...(input.effort === null ? {} : { effort: input.effort }),
              serviceTier: input.fastMode ? FAST_SERVICE_TIER : null,
              ...turnAccess(input.accessMode, sandbox),
            }
            const { turn } = yield* client.request<TurnStartResponse>("turn/start", turnStart)
            return turn.id
          })
          const startCompaction = Effect.gen(function* () {
            yield* client.request("thread/compact/start", { threadId: thread.id } satisfies ThreadCompactStartParams)
            while (true) {
              const message = yield* Queue.take(inbox)
              if (message.kind === "exit") return yield* Effect.fail(message.error)
              if (message.kind !== "notification" || message.method !== "turn/started") continue
              const params = message.params as ServerNotificationParams["turn/started"]
              if (params.threadId === thread.id) return params.turn.id
            }
          })
          run.turnStart = yield* (compacting ? startCompaction : startTurn).pipe(
            Effect.map((turnId): RemoteTurn => ({ threadId: thread.id, turnId })),
            Effect.forkIn(providerScope),
          )
          const turn = yield* Fiber.join(run.turnStart)
          run.turn = turn

          const commandOutput = new Map<string, string>()
          const startedTools = new Set<string>()
          const openTools = new Set<string>()
          const backgroundable = new Set<string>()
          const approvalIdByRpcId = new Map<string | number, string>()
          const questionIdByRpcId = new Map<string | number, string>()
          let subagents = subagentsByThread.get(input.threadId)
          if (subagents === undefined) subagentsByThread.set(input.threadId, (subagents = new Map()))
          const emitSubagents = (changed: ReadonlyArray<Subagent>) =>
            Effect.forEach(changed, (subagent) => emit({ type: "subagent_updated", subagent }), { discard: true })
          let usage: TokenUsage = { inputTokens: 0, outputTokens: 0 }
          let lastError: string | undefined
          let planRevision = 0

          yield* Effect.addFinalizer(() =>
            Effect.gen(function* () {
              for (const [rpcId, approvalId] of approvalIdByRpcId) {
                if (approvals.delete(approvalId)) yield* client.respond(rpcId, { decision: "cancel" })
              }
              for (const [rpcId, questionId] of questionIdByRpcId) {
                if (questions.delete(questionId)) yield* client.respond(rpcId, userInputResponse({}))
              }
            }),
          )

          const resolveApproval = (approvalId: string) =>
            Effect.suspend(() =>
              approvals.delete(approvalId) ? emit({ type: "approval_resolved", requestId: approvalId }) : Effect.void,
            )

          const resolveQuestion = (questionId: string) =>
            Effect.suspend(() =>
              questions.delete(questionId) ? emit({ type: "question_resolved", requestId: questionId }) : Effect.void,
            )

          const requestUserInput = (rpcId: string | number, params: ToolRequestUserInputParams) =>
            Effect.gen(function* () {
              const questionId = randomUUID()
              const answers = yield* Deferred.make<QuestionAnswers>()
              questions.set(questionId, answers)
              questionIdByRpcId.set(rpcId, questionId)
              yield* emit({
                type: "question_requested",
                request: {
                  id: questionId,
                  threadId: input.threadId,
                  provider: "codex",
                  questions: params.questions.map(toQuestion),
                },
              })
              yield* Deferred.await(answers).pipe(
                Effect.flatMap((chosen) => client.respond(rpcId, userInputResponse(chosen))),
                Effect.andThen(resolveQuestion(questionId)),
                Effect.forkScoped,
              )
            })

          const startTool = (item: ThreadItem, parentCallId?: string) => {
            const name = toolName(item)
            if (name === undefined || startedTools.has(item.id)) return Effect.void
            startedTools.add(item.id)
            openTools.add(item.id)
            return emit({
              type: "tool_call_started",
              callId: item.id,
              name,
              input: toolInput(item),
              ...(parentCallId !== undefined && { parentCallId }),
            })
          }

          const finishTool = (item: ThreadItem, parentCallId?: string) =>
            Effect.gen(function* () {
              if (toolName(item) === undefined) return
              yield* startTool(item, parentCallId)
              const result = toolResult(item, commandOutput.get(item.id))
              commandOutput.delete(item.id)
              openTools.delete(item.id)
              yield* emit({ type: "tool_call_finished", callId: item.id, ...result })
              if (item.type === "fileChange" && item.status === "completed") {
                for (const change of item.changes)
                  yield* emit({ type: "file_changed", path: change.path, diff: change.diff })
              }
            })

          const requestMcpToolApproval = (rpcId: string | number, params: McpServerElicitationRequestParams) =>
            Effect.gen(function* () {
              const approvalId = randomUUID()
              const decision = yield* Deferred.make<ApprovalDecision>()
              approvals.set(approvalId, decision)
              approvalIdByRpcId.set(rpcId, approvalId)
              yield* emit({
                type: "approval_requested",
                request: {
                  id: approvalId,
                  threadId: input.threadId,
                  provider: "codex",
                  kind: "tool",
                  title: params.message,
                  detail: `MCP server ${params.serverName}`,
                  input: params,
                },
              })
              yield* Deferred.await(decision).pipe(
                Effect.flatMap((choice) => {
                  const action: ElicitationActionWire = choice === "deny" ? "decline" : "accept"
                  return client.respond(rpcId, { action, content: null, _meta: null })
                }),
                Effect.andThen(resolveApproval(approvalId)),
                Effect.forkScoped,
              )
            })

          const requestApproval = <
            M extends "item/commandExecution/requestApproval" | "item/fileChange/requestApproval",
          >(
            rpcId: string | number,
            method: M,
            params: ServerRequestParams[M],
          ) =>
            Effect.gen(function* () {
              const approvalId = randomUUID()
              const decision = yield* Deferred.make<ApprovalDecision>()
              approvals.set(approvalId, decision)
              approvalIdByRpcId.set(rpcId, approvalId)
              const isCommand = method === "item/commandExecution/requestApproval"
              const command = isCommand
                ? (params as ServerRequestParams["item/commandExecution/requestApproval"])
                : undefined
              const patch = isCommand ? undefined : (params as ServerRequestParams["item/fileChange/requestApproval"])
              yield* emit({
                type: "approval_requested",
                request: {
                  id: approvalId,
                  threadId: input.threadId,
                  provider: "codex",
                  kind: isCommand ? "command" : "patch",
                  title: command ? (command.command ?? "Run command") : "Apply file changes",
                  detail:
                    params.reason ??
                    (command?.cwd ? `in ${command.cwd}` : patch?.grantRoot ? `write access to ${patch.grantRoot}` : ""),
                  input: params,
                },
              })
              yield* Deferred.await(decision).pipe(
                Effect.flatMap((choice) => client.respond(rpcId, { decision: decisionToWire[choice] })),
                Effect.andThen(resolveApproval(approvalId)),
                Effect.forkScoped,
              )
            })

          const handleChildTool = (childThreadId: string, method: string, params: unknown) => {
            switch (method) {
              case "item/started":
                return startTool((params as ServerNotificationParams["item/started"]).item, childThreadId)
              case "item/completed":
                return finishTool((params as ServerNotificationParams["item/completed"]).item, childThreadId)
              case "item/commandExecution/outputDelta": {
                const { itemId, delta } = params as ServerNotificationParams["item/commandExecution/outputDelta"]
                commandOutput.set(itemId, (commandOutput.get(itemId) ?? "") + delta)
                return Effect.void
              }
              default:
                return Effect.void
            }
          }

          const belongsToTurn = (params: unknown) => {
            const scope = params as { threadId?: string; turnId?: string; turn?: { id: string } } | undefined
            return scope?.threadId === thread.id && (scope.turnId ?? scope.turn?.id ?? turn.turnId) === turn.turnId
          }

          const handle = (message: Incoming): Effect.Effect<boolean, AgentError, Scope.Scope> =>
            Effect.gen(function* () {
              if (message.kind === "exit") return yield* Effect.fail(message.error)
              const childThreadId = (message.params as { threadId?: string } | undefined)?.threadId
              if (message.kind === "notification" && childThreadId !== undefined && subagents.has(childThreadId)) {
                const childScope = message.params as { turnId?: string; turn?: { id: string } }
                const childTurnId = childScope.turnId ?? childScope.turn?.id
                if (childTurnId !== undefined) subagentTurns.set(childThreadId, childTurnId)
                yield* handleChildTool(childThreadId, message.method, message.params)
                const changed = applyChildNotification(
                  subagents,
                  childThreadId,
                  message.method,
                  message.params,
                  toolName,
                )
                if (changed) yield* emitSubagents([changed])
                return false
              }
              if (!belongsToTurn(message.params)) return false

              if (message.kind === "request") {
                if (
                  message.method === "item/commandExecution/requestApproval" ||
                  message.method === "item/fileChange/requestApproval"
                ) {
                  yield* requestApproval(
                    message.id,
                    message.method,
                    message.params as ServerRequestParams[typeof message.method],
                  )
                } else if (message.method === "item/tool/requestUserInput") {
                  yield* requestUserInput(message.id, message.params as ToolRequestUserInputParams)
                } else if (message.method === "mcpServer/elicitation/request") {
                  const params = message.params as McpServerElicitationRequestParams
                  if (params._meta?.codex_approval_kind === "mcp_tool_call") {
                    yield* requestMcpToolApproval(message.id, params)
                  } else {
                    yield* client.respond(message.id, { action: "decline", content: null, _meta: null })
                  }
                } else {
                  yield* client.respondError(message.id, -32601, `HinaCode does not support ${message.method}`)
                }
                return false
              }

              const method = message.method as keyof ServerNotificationParams
              switch (method) {
                case "item/agentMessage/delta": {
                  const params = message.params as ServerNotificationParams[typeof method]
                  yield* emit({ type: "text_delta", text: params.delta })
                  return false
                }
                case "item/reasoning/summaryTextDelta":
                case "item/reasoning/textDelta": {
                  const params = message.params as ServerNotificationParams[typeof method]
                  yield* emit({ type: "reasoning_delta", text: params.delta })
                  return false
                }
                case "item/commandExecution/outputDelta": {
                  const params = message.params as ServerNotificationParams[typeof method]
                  commandOutput.set(params.itemId, (commandOutput.get(params.itemId) ?? "") + params.delta)
                  return false
                }
                case "item/started": {
                  const params = message.params as ServerNotificationParams[typeof method]
                  if (params.item.type === "contextCompaction") {
                    yield* emit({ type: "compaction_updated", compaction: { status: "running" } })
                  }
                  yield* startTool(params.item)
                  if (params.item.type === "commandExecution" && params.item.processId != null) {
                    backgroundable.add(params.item.id)
                    yield* watchTerminals(input.threadId, client, thread.id)
                  }
                  yield* emitSubagents(applyParentItem(subagents, params.item, yield* nowIso))
                  return false
                }
                case "item/completed": {
                  const params = message.params as ServerNotificationParams[typeof method]
                  if (params.item.type === "contextCompaction") {
                    yield* emit({
                      type: "compaction_updated",
                      compaction: {
                        status: "done",
                        trigger: compacting ? "manual" : "auto",
                        preTokens: null,
                        postTokens: null,
                      },
                    })
                  }
                  yield* finishTool(params.item)
                  if (params.item.type === "agentMessage" && params.item.questions) {
                    yield* emit({
                      type: "questions_posted",
                      text: params.item.text,
                      questions: params.item.questions.map(toPostedQuestion),
                    })
                  }
                  yield* emitSubagents(applyParentItem(subagents, params.item, yield* nowIso))
                  return false
                }
                case "turn/plan/updated": {
                  const params = message.params as ServerNotificationParams[typeof method]
                  const callId = `plan-${params.turnId}-${++planRevision}`
                  yield* emit({
                    type: "tool_call_started",
                    callId,
                    name: "update_plan",
                    input: { explanation: params.explanation, plan: params.plan },
                  })
                  yield* emit({ type: "tool_call_finished", callId, output: "Plan updated", isError: false })
                  return false
                }
                case "thread/tokenUsage/updated": {
                  const params = message.params as ServerNotificationParams[typeof method]
                  const { last, modelContextWindow } = params.tokenUsage
                  usage = {
                    inputTokens: usage.inputTokens + last.inputTokens,
                    outputTokens: usage.outputTokens + last.outputTokens,
                    ...(modelContextWindow !== null && {
                      context: { usedTokens: last.totalTokens, maxTokens: modelContextWindow },
                    }),
                  }
                  return false
                }
                case "error": {
                  const params = message.params as ServerNotificationParams[typeof method]
                  if (!params.willRetry) lastError = params.error.message
                  return false
                }
                case "turn/completed": {
                  const params = message.params as ServerNotificationParams[typeof method]
                  const { status, error } = params.turn
                  // FIXME: an interrupted turn completes without item/completed for the tools it cut off
                  for (const callId of openTools) {
                    const isError = status !== "completed" || !backgroundable.has(callId)
                    const output =
                      commandOutput.get(callId) ?? (isError ? `Turn ${status}` : "Running in the background")
                    yield* emit({ type: "tool_call_finished", callId, output, isError })
                  }
                  openTools.clear()
                  yield* emit(
                    status === "completed"
                      ? { type: "turn_completed", usage, forkPoint: { sessionId: thread.id, checkpoint: turn.turnId } }
                      : { type: "turn_failed", message: error?.message ?? lastError ?? `Turn ${status}` },
                  )
                  return true
                }
                default: {
                  if (message.method === "serverRequest/resolved") {
                    const { requestId } = message.params as { requestId: string | number }
                    const approvalId = approvalIdByRpcId.get(requestId)
                    if (approvalId) yield* resolveApproval(approvalId)
                    const questionId = questionIdByRpcId.get(requestId)
                    if (questionId) yield* resolveQuestion(questionId)
                  }
                  return false
                }
              }
            })

          while (!(yield* Queue.take(inbox).pipe(Effect.flatMap(handle)))) {}
        })

        const stopped = yield* Effect.raceFirst(
          stream.pipe(Effect.as(false)),
          Deferred.await(run.stop).pipe(Effect.as(true)),
        )
        if (stopped) {
          const { turnStart, client } = run
          if (turnStart && client) {
            yield* Fiber.join(turnStart).pipe(
              Effect.flatMap((turn) => interruptTurn(client, turn)),
              Effect.ignore,
              Effect.forkIn(providerScope),
            )
          }
          yield* emit(interruptedEvent)
        }
        yield* Queue.end(out)
      }),
    )

  const interrupt = (threadId: string) =>
    Effect.suspend(() => {
      const run = runs.get(threadId)
      if (!run) return Effect.void
      const stop = Deferred.succeed(run.stop, undefined)
      return run.turn && run.client ? interruptTurn(run.client, run.turn).pipe(Effect.catch(() => stop)) : stop
    }).pipe(Effect.asVoid)

  const stopSubagent = (threadId: string, subagentId: string) =>
    Effect.suspend(() => {
      const client = runs.get(threadId)?.client
      const turnId = subagentTurns.get(subagentId)
      if (client === undefined || turnId === undefined || !subagentsByThread.get(threadId)?.has(subagentId))
        return Effect.fail(new AgentError({ provider: "codex", message: "The sub-agent has no active turn to stop" }))
      return interruptTurn(client, { threadId: subagentId, turnId })
    }).pipe(Effect.asVoid)

  const steer = (threadId: string, text: string, attachments: ReadonlyArray<Attachment>) =>
    Effect.gen(function* () {
      const run = runs.get(threadId)
      const active = run?.turn
      const client = run?.client
      if (!active || !client?.isAlive()) {
        return yield* new AgentError({ provider: "codex", message: "No turn is running on this thread" })
      }
      const params: TurnSteerParams = {
        threadId: active.threadId,
        input: userInput(text, attachments),
        expectedTurnId: active.turnId,
      }
      yield* client.request("turn/steer", params)
    })

  const respondApproval = (requestId: string, decision: ApprovalDecision) =>
    Effect.suspend(() => {
      const deferred = approvals.get(requestId)
      return deferred ? Deferred.succeed(deferred, decision) : Effect.void
    }).pipe(Effect.as(false))

  const respondQuestion = (requestId: string, answers: QuestionAnswers) =>
    Effect.suspend(() => {
      const deferred = questions.get(requestId)
      return deferred ? Deferred.succeed(deferred, answers) : Effect.void
    }).pipe(Effect.asVoid)

  return {
    id: "codex",
    listModels,
    account,
    planLimits,
    usage: readUsage,
    copySession,
    listSessions,
    readSession,
    listCommands,
    runTurn,
    backgroundTasks: { changes: Stream.fromQueue(backgroundTaskChanges), stop: stopBackgroundTask },
    steer,
    interrupt,
    closeSession,
    stopSubagent,
    respondApproval,
    respondQuestion,
    setAccessMode: () => Effect.void,
  } satisfies AgentProvider
})

const planNames: Partial<Record<PlanType, string>> = {
  free: "Free",
  go: "Go",
  plus: "Plus",
  pro: "Pro",
  team: "Team",
  business: "Business",
  enterprise: "Enterprise",
  edu: "Edu",
}

const planName = (plan: PlanType) =>
  plan === "unknown"
    ? null
    : `ChatGPT ${
        planNames[plan] ??
        plan
          .split("_")
          .map((word) => word[0]?.toUpperCase() + word.slice(1))
          .join(" ")
      }`

const toAccount = (account: GetAccountResponse["account"]): AgentAccount => {
  switch (account?.type) {
    case undefined:
      return { type: "signedOut" }
    case "apiKey":
      return { type: "apiKey" }
    case "chatgpt":
      return { type: "subscription", email: account.email, plan: planName(account.planType), organization: null }
    case "amazonBedrock":
      return { type: "external", service: "Amazon Bedrock" }
  }
}

const SESSION_MINUTES = 5 * 60
const WEEK_MINUTES = 7 * 24 * 60

const toLimitWindow = (window: RateLimitWindow | null): ReadonlyArray<LimitWindow> => {
  const minutes = window?.windowDurationMins ?? null
  if (window === null || minutes === null) return []
  return [
    {
      window:
        minutes === SESSION_MINUTES
          ? { kind: "session" }
          : minutes === WEEK_MINUTES
            ? { kind: "weekly" }
            : { kind: "minutes", minutes },
      usedPercent: window.usedPercent,
      resetsAt: window.resetsAt === null ? null : new Date(window.resetsAt * 1000).toISOString(),
    },
  ]
}

const toPlanLimits = (response: GetAccountRateLimitsResponse, readAt: string): PlanLimits => {
  const snapshot = response.rateLimitsByLimitId?.["codex"] ?? response.rateLimits
  return { windows: [...toLimitWindow(snapshot.primary), ...toLimitWindow(snapshot.secondary)], readAt }
}

export class CodexProvider extends Context.Service<CodexProvider, AgentProvider>()("hinacode/CodexProvider") {
  static readonly layer = Layer.effect(CodexProvider, make)
}
