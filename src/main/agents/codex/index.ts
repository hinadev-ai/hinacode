import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { Context, Deferred, Effect, Exit, Fiber, Layer, Option, Queue, Schema, Scope, Semaphore, Stream } from "effect"
import type {
  AgentAccount,
  AgentCommand,
  AgentEvent,
  ApprovalDecision,
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
import { AgentError, type AgentProvider, type SignIn } from "../provider.ts"
import { threadAccess, turnAccess } from "./access.ts"
import { type CodexClient, type Incoming, makeCodexClient } from "./client.ts"
import { codexHome, makeRolloutUsage } from "./rollouts.ts"
import { applyChildNotification, applyParentItem, type Subagents } from "./subagents.ts"
import {
  GetAccountRateLimitsResponse,
  AccountLoginCompletedNotification,
  GetAccountResponse,
  type RateLimitWindow,
  LoginAccountResponse,
} from "./protocol.ts"
import type {
  ApprovalDecisionWire,
  AsyncUserInputQuestion,
  CancelLoginAccountParams,
  LoginAccountParams,
  ElicitationActionWire,
  GetAccountParams,
  McpServerElicitationRequestParams,
  ModelListParams,
  ModelListResponse,
  PlanType,
  ServerNotificationParams,
  ServerRequestParams,
  SkillMetadata,
  SkillsListParams,
  SkillsListResponse,
  ThreadItem,
  ThreadResumeParams,
  ThreadStartParams,
  ThreadStartResponse,
  TurnInterruptParams,
  TurnStartParams,
  TurnStartResponse,
  ToolRequestUserInputParams,
  ToolRequestUserInputQuestion,
  ToolRequestUserInputResponse,
  TurnSteerParams,
  UserInput,
} from "./protocol.ts"

const CLIENT_VERSION = "0.1.0"

/** The service tier Codex labels "Fast". */
const FAST_SERVICE_TIER = "priority"

const decisionToWire: Record<ApprovalDecision, ApprovalDecisionWire> = {
  allow: "accept",
  allow_for_session: "acceptForSession",
  deny: "decline",
}

/** A packaged Electron app may not inherit the shell PATH (mise, Homebrew), so fall back to a login shell. */
const resolveCodexBinary = (): string => {
  const attempts: Array<[string, Array<string>]> = [
    ["which", ["codex"]],
    [process.env.SHELL ?? "/bin/sh", ["-ilc", "command -v codex"]],
  ]
  for (const [command, args] of attempts) {
    try {
      const path = execFileSync(command, args, { encoding: "utf8", timeout: 5000 }).trim().split("\n").at(-1)
      if (path) return path
    } catch {}
  }
  return "codex"
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

const toPostedQuestion = (question: AsyncUserInputQuestion): Question => ({
  id: question.title,
  header: "",
  question: question.title,
  options: (question.options ?? []).map((label) => ({ label, description: "" })),
  multiSelect: false,
  allowsText: true,
  secret: false,
})

const userInputResponse = (answers: QuestionAnswers): ToolRequestUserInputResponse => ({
  answers: Object.fromEntries(Object.entries(answers).map(([id, values]) => [id, { answers: [...values] }])),
})

const textInput = (text: string): UserInput => ({ type: "text", text, text_elements: [] })

/** Images go in as local paths; other files are named by path so the agent reads them with its own tools. */
const userInput = (text: string, attachments: ReadonlyArray<Attachment>): Array<UserInput> => [
  ...(text === "" ? [] : [textInput(text)]),
  ...attachments.map((attachment) =>
    attachment.kind === "image"
      ? { type: "localImage" as const, path: attachment.path }
      : textInput(`Attached file: ${attachment.path}`),
  ),
]

/** Codex expands a skill only when it arrives as its own input item next to the `$name` in the text. */
const skillInputs = (text: string, skills: ReadonlyArray<SkillMetadata>): Array<UserInput> =>
  skills
    .filter((skill) => skill.enabled && text.includes(`$${skill.name}`))
    .map((skill) => ({ type: "skill", name: skill.name, path: skill.path }))

const toolName = (item: ThreadItem): string | undefined => {
  switch (item.type) {
    // "Bash" matches Claude's tool name, so the row gets the terminal icon and summarizes `command`.
    case "commandExecution":
      return "Bash"
    case "mcpToolCall":
      return item.tool
    case "fileChange":
      return "Edit"
    default:
      return undefined
  }
}

/** A `path` field lets the tool row summarize a file change by what it touched instead of raw JSON. */
const toolInput = (item: ThreadItem): unknown =>
  item.type === "fileChange" ? { path: item.changes.map((change) => change.path).join(", "), ...item } : item

const toolResult = (item: ThreadItem, bufferedOutput: string | undefined): { output: unknown; isError: boolean } => {
  switch (item.type) {
    case "commandExecution":
      return {
        output: item.aggregatedOutput ?? bufferedOutput ?? item.status,
        isError: item.status !== "completed" || (item.exitCode !== null && item.exitCode !== 0),
      }
    case "mcpToolCall":
      return { output: item.error ?? item.result, isError: item.status !== "completed" }
    case "fileChange":
      return { output: item.status, isError: item.status !== "completed" }
    default:
      return { output: null, isError: false }
  }
}

type RemoteTurn = { readonly threadId: string; readonly turnId: string }

/** A turn on one kkcode thread, from the moment it is asked for until its stream ends. */
type Run = {
  /** Completed by Stop when there is no started remote turn to interrupt. */
  readonly stop: Deferred.Deferred<void>
  /** The app-server of the thread's account, which alone knows the run's remote turn. */
  client?: CodexClient
  /** Outlives a stopped run, so a turn Codex starts after Stop can still be interrupted. */
  turnStart?: Fiber.Fiber<RemoteTurn, AgentError>
  turn?: RemoteTurn
}

const interruptTurn = (client: CodexClient, turn: RemoteTurn) =>
  Effect.suspend(() =>
    client.isAlive() ? client.request("turn/interrupt", turn satisfies TurnInterruptParams) : Effect.void,
  )

const interruptedEvent: AgentEvent = { type: "turn_failed", message: "Turn interrupted" }

const make = Effect.gen(function* () {
  const providerScope = yield* Effect.scope
  const binaryPath = resolveCodexBinary()
  const clientLock = yield* Semaphore.make(1)
  /** Keyed by agent home, "" for the CLI's own one. */
  const clients = new Map<string, { readonly client: CodexClient; readonly scope: Scope.Closeable }>()

  /**
   * One app-server per agent home, since `CODEX_HOME` holds the login and the transcripts. Spawned on
   * first use and respawned after it dies.
   */
  const getClient = (home: string | null) =>
    Semaphore.withPermit(
      clientLock,
      Effect.gen(function* () {
        const current = clients.get(home ?? "")
        if (current?.client.isAlive()) return current.client
        if (current) yield* Scope.close(current.scope, Exit.void)
        const scope = yield* Scope.make()
        const env = home === null ? { ...process.env } : { ...process.env, CODEX_HOME: home }
        const client = yield* makeCodexClient({ binaryPath, clientVersion: CLIENT_VERSION, env }).pipe(
          Scope.provide(scope),
          Effect.onError(() => Scope.close(scope, Exit.void)),
        )
        clients.set(home ?? "", { client, scope })
        return client
      }),
    )
  yield* Effect.addFinalizer(() =>
    Effect.forEach(clients.values(), ({ scope }) => Scope.close(scope, Exit.void), { discard: true }),
  )

  /** Pending approvals keyed by the kkcode approval id handed to the UI. */
  const approvals = new Map<string, Deferred.Deferred<ApprovalDecision>>()
  /** Pending `request_user_input` calls keyed by the kkcode question id handed to the UI. */
  const questions = new Map<string, Deferred.Deferred<QuestionAnswers>>()
  /** In-flight runs keyed by kkcode threadId, for steer and interrupt. */
  const runs = new Map<string, Run>()
  /** Keyed by kkcode threadId; a sub-agent can outlive the turn that spawned it. */
  const subagentsByThread = new Map<string, Subagents>()

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
          // `on-request` lets Codex run sandboxed work and decide itself when to ask.
          autoMode: true,
        })
      }
      cursor = page.nextCursor
    } while (cursor)
    return models
  })

  const planLimits = Effect.gen(function* () {
    const client = yield* getClient(null)
    const raw = yield* client.request<unknown>("account/rateLimits/read", undefined)
    const response = yield* Schema.decodeUnknownEffect(GetAccountRateLimitsResponse)(raw).pipe(
      Effect.mapError(
        () => new AgentError({ provider: "codex", message: "Failed to read Codex plan limits: invalid response" }),
      ),
    )
    return toPlanLimits(response, yield* nowIso)
  })

  const rolloutUsage = makeRolloutUsage(codexHome())
  const readUsage = (threadId: string) =>
    Effect.tryPromise({
      try: () => rolloutUsage(threadId),
      catch: (cause) =>
        new AgentError({ provider: "codex", message: `Failed to read Codex rollouts: ${String(cause)}` }),
    })

  const account = (home: string | null) =>
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

  const signIn = (home: string) =>
    Effect.gen(function* () {
      const client = yield* getClient(home)
      // Subscribed first, so a login that completes right away is not missed.
      const completions = yield* Queue.unbounded<Incoming>()
      yield* client.subscribe((message) => Queue.offerUnsafe(completions, message))
      const raw = yield* client.request<unknown>("account/login/start", {
        type: "chatgpt",
      } satisfies LoginAccountParams)
      const { loginId, authUrl } = yield* Schema.decodeUnknownEffect(LoginAccountResponse)(raw).pipe(
        Effect.mapError(
          () => new AgentError({ provider: "codex", message: "Failed to start the Codex sign-in: invalid response" }),
        ),
      )
      const done = yield* Deferred.make<void, AgentError>()
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          if (yield* Deferred.isDone(done)) return
          yield* client
            .request("account/login/cancel", { loginId } satisfies CancelLoginAccountParams)
            .pipe(Effect.ignore)
        }),
      )
      const decodeCompletion = Schema.decodeUnknownOption(AccountLoginCompletedNotification)
      const completed = Effect.gen(function* () {
        while (true) {
          const message = yield* Queue.take(completions)
          if (message.kind === "exit") return yield* Effect.fail(message.error)
          if (message.kind !== "notification" || message.method !== "account/login/completed") continue
          const completion = Option.getOrUndefined(decodeCompletion(message.params))
          if (completion?.loginId !== loginId) continue
          if (completion.success) return
          return yield* new AgentError({ provider: "codex", message: completion.error ?? "Codex sign-in failed" })
        }
      }).pipe(Effect.onExit((exit) => Deferred.done(done, Exit.asVoid(exit))))
      const pending: SignIn = { url: authUrl, openedBrowser: false, submitCode: null, completed }
      return pending
    })

  /** Also stops the home's app-server, since a removed account's home is deleted right after. */
  const signOut = (home: string) =>
    getClient(home).pipe(
      Effect.flatMap((client) => client.request("account/logout", undefined)),
      Effect.ensuring(
        Semaphore.withPermit(
          clientLock,
          Effect.suspend(() => {
            const current = clients.get(home)
            clients.delete(home)
            return current ? Scope.close(current.scope, Exit.void) : Effect.void
          }),
        ),
      ),
      Effect.asVoid,
    )

  const listSkills = (cwd: string, home: string | null) =>
    Effect.gen(function* () {
      const client = yield* getClient(home)
      const params: SkillsListParams = { cwds: [cwd] }
      const response = yield* client.request<SkillsListResponse>("skills/list", params)
      return response.data.flatMap((entry) => entry.skills)
    })

  const listCommands = ({ cwd, home }: { readonly cwd: string; readonly home: string | null }) =>
    listSkills(cwd, home).pipe(
      Effect.map((skills) =>
        skills
          .filter((skill) => skill.enabled)
          .map((skill): AgentCommand => ({
            trigger: "$",
            name: skill.name,
            description: skill.shortDescription ?? skill.description,
            argumentHint: "",
          })),
      ),
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

          // Subscribe before starting so no notification is missed; they wait here until the turn id is known.
          const inbox = yield* Queue.unbounded<Incoming>()
          yield* client.subscribe((message) => Queue.offerUnsafe(inbox, message))

          const overrides = {
            cwd: input.cwd,
            model: input.model,
            ...threadAccess(input.accessMode),
            config: {
              mcp_servers: {
                // `request_secret` waits for the user, so the default 60 s tool timeout is too short.
                kkcode: { url: input.mcpServer.url, http_headers: input.mcpServer.headers, tool_timeout_sec: 600 },
              },
            },
          } satisfies ThreadStartParams
          const { thread, sandbox } = input.resumeSessionId
            ? yield* client.request<ThreadStartResponse>("thread/resume", {
                ...overrides,
                threadId: input.resumeSessionId,
                excludeTurns: true,
              } satisfies ThreadResumeParams)
            : yield* client.request<ThreadStartResponse>("thread/start", overrides)
          yield* emit({ type: "session_bound", providerSessionId: thread.id })

          const skills = input.prompt.includes("$") ? yield* listSkills(input.cwd, input.home) : []
          const turnStart: TurnStartParams = {
            threadId: thread.id,
            input: [...userInput(input.prompt, input.attachments), ...skillInputs(input.prompt, skills)],
            cwd: input.cwd,
            ...(input.effort === null ? {} : { effort: input.effort }),
            serviceTier: input.fastMode ? FAST_SERVICE_TIER : null,
            ...turnAccess(input.accessMode, sandbox),
          }
          run.turnStart = yield* client.request<TurnStartResponse>("turn/start", turnStart).pipe(
            Effect.map(({ turn }): RemoteTurn => ({ threadId: thread.id, turnId: turn.id })),
            Effect.forkIn(providerScope),
          )
          const turn = yield* Fiber.join(run.turnStart)
          run.turn = turn

          const commandOutput = new Map<string, string>()
          const startedTools = new Set<string>()
          const openTools = new Set<string>()
          const approvalIdByRpcId = new Map<string | number, string>()
          const questionIdByRpcId = new Map<string | number, string>()
          let subagents = subagentsByThread.get(input.threadId)
          if (subagents === undefined) subagentsByThread.set(input.threadId, (subagents = new Map()))
          const emitSubagents = (changed: ReadonlyArray<Subagent>) =>
            Effect.forEach(changed, (subagent) => emit({ type: "subagent_updated", subagent }), { discard: true })
          let usage: TokenUsage = { inputTokens: 0, outputTokens: 0 }
          let lastError: string | undefined

          yield* Effect.addFinalizer(() =>
            Effect.gen(function* () {
              // The consumer went away mid-approval: unblock Codex instead of leaving the request hanging.
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

          const startTool = (item: ThreadItem) => {
            const name = toolName(item)
            if (name === undefined || startedTools.has(item.id)) return Effect.void
            startedTools.add(item.id)
            openTools.add(item.id)
            return emit({ type: "tool_call_started", callId: item.id, name, input: toolInput(item) })
          }

          const finishTool = (item: ThreadItem) =>
            Effect.gen(function* () {
              if (toolName(item) === undefined) return
              yield* startTool(item)
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

          const belongsToTurn = (params: unknown) => {
            const scope = params as { threadId?: string; turnId?: string; turn?: { id: string } } | undefined
            return scope?.threadId === thread.id && (scope.turnId ?? scope.turn?.id ?? turn.turnId) === turn.turnId
          }

          /** Returns true once the turn is over. */
          const handle = (message: Incoming): Effect.Effect<boolean, AgentError, Scope.Scope> =>
            Effect.gen(function* () {
              if (message.kind === "exit") return yield* Effect.fail(message.error)
              const childThreadId = (message.params as { threadId?: string } | undefined)?.threadId
              if (message.kind === "notification" && childThreadId !== undefined && subagents.has(childThreadId)) {
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
                  yield* client.respondError(message.id, -32601, `kkcode does not support ${message.method}`)
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
                  yield* startTool(params.item)
                  yield* emitSubagents(applyParentItem(subagents, params.item, yield* nowIso))
                  return false
                }
                case "item/completed": {
                  const params = message.params as ServerNotificationParams[typeof method]
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
                case "thread/tokenUsage/updated": {
                  const params = message.params as ServerNotificationParams[typeof method]
                  const { last, modelContextWindow } = params.tokenUsage
                  // `last` is one model request; a turn makes several, so their sum is the turn's usage.
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
                  // A fatal error is always followed by turn/completed with status "failed", which ends the stream.
                  if (!params.willRetry) lastError = params.error.message
                  return false
                }
                case "turn/completed": {
                  const params = message.params as ServerNotificationParams[typeof method]
                  const { status, error } = params.turn
                  // An interrupted turn completes without item/completed for the tools it cut off.
                  for (const callId of openTools) {
                    const output = commandOutput.get(callId) ?? `Turn ${status}`
                    yield* emit({ type: "tool_call_finished", callId, output, isError: true })
                  }
                  openTools.clear()
                  yield* emit(
                    status === "completed"
                      ? { type: "turn_completed", usage }
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

  /** Interrupts the remote turn once Codex has one; before that, or if Codex does not answer, ends the run locally. */
  const interrupt = (threadId: string) =>
    Effect.suspend(() => {
      const run = runs.get(threadId)
      if (!run) return Effect.void
      const stop = Deferred.succeed(run.stop, undefined)
      return run.turn && run.client ? interruptTurn(run.client, run.turn).pipe(Effect.catch(() => stop)) : stop
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
    }).pipe(Effect.asVoid)

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
    signIn,
    signOut,
    listCommands,
    runTurn,
    steer,
    interrupt,
    respondApproval,
    respondQuestion,
    // Codex takes a new approval policy and sandbox with the next turn/start.
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

/** Codex reports plan ids, not names. Ids without a known public name are title-cased. */
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

/** A window without a duration can't be named, so it is left out. */
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

/** The `codex` bucket is what Codex itself meters; the legacy single snapshot stands in when it is missing. */
const toPlanLimits = (response: GetAccountRateLimitsResponse, readAt: string): PlanLimits => {
  const snapshot = response.rateLimitsByLimitId?.["codex"] ?? response.rateLimits
  return { windows: [...toLimitWindow(snapshot.primary), ...toLimitWindow(snapshot.secondary)], readAt }
}

export class CodexProvider extends Context.Service<CodexProvider, AgentProvider>()("kkcode/CodexProvider") {
  static readonly layer = Layer.effect(CodexProvider, make)
}
