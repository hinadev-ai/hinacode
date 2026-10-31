import { randomUUID } from "node:crypto"
import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { Deferred, Duration, Effect, Exit, Queue, Schema, Scope, Semaphore, Stream } from "effect"
import type {
  AccountHome,
  AgentAccount,
  AgentCommand,
  AgentEvent,
  ApprovalDecision,
  ModelInfo,
  ProviderId,
  RunTurnInput,
} from "../../../shared/agent.ts"
import type { AccessMode, Attachment } from "../../../shared/domain.ts"
import { providerCli } from "../../../shared/providers.ts"
import { installedBinary } from "../binary.ts"
import { attachmentContext } from "../elementContext.ts"
import { AgentError, type AgentProvider } from "../provider.ts"
import { autoAllows, mergePermissionTool, optionFor, permissionOutcome, toApprovalRequest } from "./approvals.ts"
import { type AcpClient, type AcpFailure, type Incoming, makeAcpClient, type RequestId } from "./client.ts"
import { modelSelector, type ModelSelector, toModelInfos } from "./models.ts"
import {
  type AgentCapabilities,
  AvailableCommandsUpdate,
  ConfigOptionUpdate,
  InitializeResponse,
  METHOD_NOT_FOUND,
  NewSessionResponse,
  type PermissionOption,
  PROTOCOL_VERSION,
  PromptResponse,
  RequestPermissionParams,
  SessionNotification,
  SessionSetup,
} from "./protocol.ts"
import { makeUpdateMapper, type UpdateMapper } from "./updates.ts"

export interface AcpAgentConfig {
  readonly id: ProviderId
  readonly binary?: string
  readonly args: ReadonlyArray<string>
  readonly env: Readonly<Record<string, string>>
  readonly authMethod: string | null
  readonly loginCommand: string
  readonly account: Effect.Effect<AgentAccount, AgentError>
}

const CLIENT_VERSION = "0.1.0"
const INITIALIZE_TIMEOUT = Duration.seconds(30)
const AUTHENTICATE_TIMEOUT = Duration.seconds(10)
const INTERRUPT_GRACE = Duration.seconds(5)
const MAX_IMAGE_BYTES = 5 * 1024 * 1024
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"])

const interruptedEvent: AgentEvent = { type: "turn_failed", message: "Turn interrupted" }

interface LoadedSession {
  model: ModelSelector | null
  needsInstructions: boolean
}

interface Entry {
  readonly client: AcpClient
  readonly scope: Scope.Closeable
  readonly capabilities: AgentCapabilities
  readonly sessions: Map<string, LoadedSession>
  readonly commands: Map<string, ReadonlyArray<AgentCommand>>
  authenticated: boolean
}

interface PendingPermission {
  readonly approvalId: string | null
  readonly options: ReadonlyArray<PermissionOption>
}

interface Run {
  readonly stop: Deferred.Deferred<void>
  readonly permissions: Map<RequestId, PendingPermission>
  client?: AcpClient
  sessionId?: string
  mapper?: UpdateMapper
  prompting: boolean
}

type ContentBlock =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "image"; readonly data: string; readonly mimeType: string }

const textBlock = (text: string): ContentBlock => ({ type: "text", text })

type TurnMessage = Incoming | { readonly kind: "prompted"; readonly exit: Exit.Exit<PromptResponse, AgentError> }

const decodeNotification = Schema.decodeUnknownOption(SessionNotification)
const decodeCommands = Schema.decodeUnknownOption(AvailableCommandsUpdate)
const decodeConfigUpdate = Schema.decodeUnknownOption(ConfigOptionUpdate)
const decodePermission = Schema.decodeUnknownOption(RequestPermissionParams)

const mcpServers = (input: RunTurnInput) => [
  {
    type: "http",
    name: "hinacode",
    url: input.mcpServer.url,
    headers: [{ name: "authorization", value: input.mcpServer.headers.authorization }],
  },
]

const isAuthRequired = (failure: AcpFailure) =>
  failure._tag === "AcpCallError" && /authentication required/i.test(`${failure.message} ${failure.detail ?? ""}`)

const sessionIdOf = (params: unknown) => {
  const sessionId = typeof params === "object" && params !== null ? Reflect.get(params, "sessionId") : undefined
  return typeof sessionId === "string" ? sessionId : undefined
}

export const makeAcpProvider = (config: AcpAgentConfig) =>
  Effect.gen(function* () {
    const providerScope = yield* Effect.scope
    const { name } = providerCli[config.id]
    const agentError = (message: string) => new AgentError({ provider: config.id, message })

    const signedOut = `${name} is not signed in. Run \`${config.loginCommand}\` in a terminal, then try again`

    const toAgentError = (failure: AcpFailure) => {
      if (isAuthRequired(failure) || ("method" in failure && failure.method === "authenticate")) {
        return agentError(signedOut)
      }
      switch (failure._tag) {
        case "AcpCallError": {
          const detail = failure.detail === null || failure.detail === failure.message ? "" : ` (${failure.detail})`
          return agentError(`${name} ${failure.method} failed: ${failure.message}${detail}`)
        }
        case "AcpTimeout":
          return agentError(`${name} did not answer ${failure.method} within ${failure.after}`)
        case "AcpExit":
          return agentError(failure.message)
      }
    }

    const decodeResponse =
      <A>(method: string, schema: Schema.Decoder<A>) =>
      (raw: unknown) =>
        Schema.decodeUnknownEffect(schema)(raw).pipe(
          Effect.mapError(() => agentError(`${name} sent an invalid ${method} response`)),
        )

    const call = <A>(
      client: AcpClient,
      method: string,
      params: unknown,
      schema: Schema.Decoder<A>,
      timeout?: Duration.Duration | null,
    ) =>
      client
        .request(method, params, timeout)
        .pipe(Effect.mapError(toAgentError), Effect.flatMap(decodeResponse(method, schema)))

    const authenticate = (entry: Entry, methodId: string) =>
      entry.client
        .request("authenticate", { methodId }, AUTHENTICATE_TIMEOUT)
        .pipe(Effect.tap(() => Effect.sync(() => (entry.authenticated = true))))

    const sessionCall = <A>(entry: Entry, method: string, params: unknown, schema: Schema.Decoder<A>) => {
      const send = entry.client.request(method, params)
      return send.pipe(
        Effect.catchIf(
          (failure) => isAuthRequired(failure) && config.authMethod !== null && !entry.authenticated,
          () => authenticate(entry, config.authMethod!).pipe(Effect.andThen(send)),
        ),
        Effect.mapError(toAgentError),
        Effect.flatMap(decodeResponse(method, schema)),
      )
    }

    const entryLock = yield* Semaphore.make(1)
    let current: Entry | undefined
    const runs = new Map<string, Run>()
    const threadSessions = new Map<string, string>()
    const accessModes = new Map<string, AccessMode>()
    const approvals = new Map<string, Deferred.Deferred<ApprovalDecision>>()

    const runOfSession = (sessionId: string) => [...runs.values()].find((run) => run.sessionId === sessionId)

    const trackSession = (entry: Entry, params: unknown) => {
      const notification = decodeNotification(params)
      if (notification._tag === "None") return
      const { sessionId, update } = notification.value
      const commands = decodeCommands(update)
      if (commands._tag === "Some") {
        entry.commands.set(
          sessionId,
          commands.value.availableCommands.map((command) => ({
            trigger: "/",
            name: command.name,
            description: command.description ?? "",
            argumentHint: command.input?.hint ?? "",
          })),
        )
      }
      const configUpdate = decodeConfigUpdate(update)
      const session = entry.sessions.get(sessionId)
      if (configUpdate._tag === "Some" && session !== undefined) {
        session.model = modelSelector({ configOptions: configUpdate.value.configOptions }) ?? session.model
      }
    }

    const answerUnowned = (client: AcpClient, message: Incoming) => {
      if (message.kind !== "request") return
      if (message.method !== "session/request_permission") {
        Effect.runSync(client.respondError(message.id, METHOD_NOT_FOUND, `${message.method} is not supported`))
        return
      }
      const sessionId = sessionIdOf(message.params)
      if (sessionId === undefined || runOfSession(sessionId) === undefined) {
        Effect.runSync(client.respond(message.id, permissionOutcome(undefined)))
      }
    }

    const getEntry = (home: AccountHome | null) =>
      Semaphore.withPermit(
        entryLock,
        Effect.gen(function* () {
          if (home !== null) return yield* agentError(`${name} runs on its CLI login only`)
          if (current?.client.isAlive()) return current
          if (current) yield* Scope.close(current.scope, Exit.void)
          const binaryPath = config.binary ?? (yield* installedBinary(config.id, providerCli[config.id].binary))
          const scope = yield* Scope.make()
          const entry = yield* Effect.gen(function* () {
            const client = yield* makeAcpClient({
              binaryPath,
              args: config.args,
              env: { ...process.env, ...config.env },
            })
            const initialized = yield* call(
              client,
              "initialize",
              {
                protocolVersion: PROTOCOL_VERSION,
                clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
                clientInfo: { name: "hinacode", title: "HinaCode", version: CLIENT_VERSION },
              },
              InitializeResponse,
              INITIALIZE_TIMEOUT,
            )
            const started: Entry = {
              client,
              scope,
              capabilities: initialized.agentCapabilities ?? {},
              sessions: new Map(),
              commands: new Map(),
              authenticated: false,
            }
            yield* client.subscribe((message) => {
              if (message.kind === "notification" && message.method === "session/update") {
                trackSession(started, message.params)
              }
              answerUnowned(client, message)
            })
            return started
          }).pipe(
            Scope.provide(scope),
            Effect.onError(() => Scope.close(scope, Exit.void)),
          )
          current = entry
          return entry
        }),
      )
    yield* Effect.addFinalizer(() => (current ? Scope.close(current.scope, Exit.void) : Effect.void))

    const newSession = (entry: Entry, cwd: string, servers: ReadonlyArray<unknown>) =>
      Effect.gen(function* () {
        const created = yield* sessionCall(entry, "session/new", { cwd, mcpServers: servers }, NewSessionResponse)
        const session: LoadedSession = { model: modelSelector(created), needsInstructions: true }
        entry.sessions.set(created.sessionId, session)
        return { sessionId: created.sessionId, setup: created, session }
      })

    const loadSession = (entry: Entry, sessionId: string, input: RunTurnInput) =>
      Effect.gen(function* () {
        const known = entry.sessions.get(sessionId)
        if (known !== undefined) return known
        if (entry.capabilities.loadSession !== true) return undefined
        const params = { sessionId, cwd: input.cwd, mcpServers: mcpServers(input) }
        const loaded = yield* sessionCall(entry, "session/load", params, SessionSetup).pipe(
          Effect.catchIf(
            (error) => error.message !== signedOut,
            (error) =>
              Effect.logWarning(`${name} could not load session ${sessionId}`, error.message).pipe(
                Effect.as(undefined),
              ),
          ),
        )
        if (loaded === undefined) return undefined
        const session: LoadedSession = { model: modelSelector(loaded), needsInstructions: false }
        entry.sessions.set(sessionId, session)
        return session
      })

    const selectModel = (entry: Entry, sessionId: string, session: LoadedSession, model: string) =>
      Effect.gen(function* () {
        const selector = session.model
        if (model === "" || selector === null || selector.current === model) return
        if (selector.via === "config") {
          const params = { sessionId, configId: selector.configId, value: model }
          yield* call(entry.client, "session/set_config_option", params, Schema.Unknown)
          session.model = { ...selector, current: model }
        } else {
          yield* call(entry.client, "session/set_model", { sessionId, modelId: model }, Schema.Unknown)
          session.model = { ...selector, current: model }
        }
      })

    const openSession = (entry: Entry, input: RunTurnInput) =>
      Effect.gen(function* () {
        const resumed =
          input.resumeSessionId === null ? undefined : yield* loadSession(entry, input.resumeSessionId, input)
        const opened =
          resumed === undefined || input.resumeSessionId === null
            ? yield* newSession(entry, input.cwd, mcpServers(input))
            : { sessionId: input.resumeSessionId, session: resumed }
        threadSessions.set(input.threadId, opened.sessionId)
        yield* selectModel(entry, opened.sessionId, opened.session, input.model)
        return opened
      })

    const promptBlocks = (text: string, attachments: ReadonlyArray<Attachment>, images: boolean) =>
      Effect.forEach(attachments, (attachment): Effect.Effect<ReadonlyArray<ContentBlock>, AgentError> => {
        const fitsImage =
          images &&
          attachment.kind === "image" &&
          IMAGE_TYPES.has(attachment.mime) &&
          attachment.bytes <= MAX_IMAGE_BYTES
        if (!fitsImage) return Effect.succeed([textBlock(`Attached file: ${attachment.path}`)])
        return Effect.tryPromise({
          try: () => readFile(attachment.path),
          catch: (cause) => agentError(`Failed to read ${attachment.name}: ${String(cause)}`),
        }).pipe(
          Effect.map((data) => {
            const context = attachmentContext(attachment)
            return [
              { type: "image", data: data.toString("base64"), mimeType: attachment.mime },
              ...(context === null ? [] : [textBlock(context)]),
            ]
          }),
        )
      }).pipe(Effect.map((parts) => [...(text === "" ? [] : [textBlock(text)]), ...parts.flat()]))

    const answerPermission = (run: Run, requestId: RequestId, option: PermissionOption | undefined) =>
      Effect.suspend(() => {
        const pending = run.permissions.get(requestId)
        if (pending === undefined || run.client === undefined) return Effect.void
        run.permissions.delete(requestId)
        if (pending.approvalId !== null) approvals.delete(pending.approvalId)
        return run.client.respond(requestId, permissionOutcome(option))
      })

    const cancelPermissions = (run: Run) =>
      Effect.forEach([...run.permissions.keys()], (requestId) => answerPermission(run, requestId, undefined), {
        discard: true,
      })

    const requestPermission = (
      threadId: string,
      run: Run,
      requestId: RequestId,
      raw: unknown,
      emit: (event: AgentEvent) => Effect.Effect<boolean>,
    ) =>
      Effect.gen(function* () {
        const decoded = decodePermission(raw)
        if (decoded._tag === "None") {
          run.permissions.set(requestId, { approvalId: null, options: [] })
          return yield* answerPermission(run, requestId, undefined)
        }
        const params = decoded.value
        const tool = mergePermissionTool(run.mapper?.tool(params.toolCall.toolCallId), params)
        const mode = accessModes.get(threadId) ?? "supervised"
        if (autoAllows(mode, tool.kind)) {
          run.permissions.set(requestId, { approvalId: null, options: params.options })
          return yield* answerPermission(run, requestId, optionFor("allow", params.options))
        }
        const approvalId = randomUUID()
        const decision = yield* Deferred.make<ApprovalDecision>()
        approvals.set(approvalId, decision)
        run.permissions.set(requestId, { approvalId, options: params.options })
        yield* emit({
          type: "approval_requested",
          request: toApprovalRequest({ id: approvalId, threadId, provider: config.id, tool, params }),
        })
        yield* Deferred.await(decision).pipe(
          Effect.flatMap((chosen) =>
            answerPermission(run, requestId, optionFor(chosen, params.options)).pipe(
              Effect.andThen(emit({ type: "approval_resolved", requestId: approvalId })),
            ),
          ),
          Effect.forkScoped,
        )
      })

    const finishTurn = (
      mapper: UpdateMapper,
      exit: Exit.Exit<PromptResponse, AgentError>,
      emit: (event: AgentEvent) => Effect.Effect<boolean>,
    ) =>
      Effect.gen(function* () {
        if (Exit.isFailure(exit)) {
          for (const event of mapper.closeOpenTools("Turn failed")) yield* emit(event)
          return yield* exit
        }
        const { stopReason, usage } = exit.value
        for (const event of mapper.closeOpenTools(stopReason === "cancelled" ? "Interrupted" : "Turn ended")) {
          yield* emit(event)
        }
        const context = mapper.context()
        switch (stopReason) {
          case "cancelled":
            return yield* emit(interruptedEvent)
          case "refusal":
            return yield* emit({ type: "turn_failed", message: `${name} refused to continue this turn` })
          case "max_tokens":
            return yield* emit({ type: "turn_failed", message: `${name} stopped at the model's output token limit` })
          case "max_turn_requests":
            return yield* emit({ type: "turn_failed", message: `${name} stopped at its request limit for one turn` })
          default:
            return yield* emit({
              type: "turn_completed",
              usage: {
                inputTokens: usage?.inputTokens ?? 0,
                outputTokens: usage?.outputTokens ?? 0,
                ...(context && { context }),
              },
            })
        }
      })

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
          const run: Run = { stop: yield* Deferred.make<void>(), permissions: new Map(), prompting: false }
          runs.set(threadId, run)
          yield* Effect.addFinalizer(() =>
            cancelPermissions(run).pipe(
              Effect.andThen(Effect.sync(() => runs.get(threadId) === run && runs.delete(threadId))),
            ),
          )
          const stopped = yield* Effect.raceFirst(
            follow(run, emit).pipe(Effect.as(false)),
            Deferred.await(run.stop).pipe(Effect.as(true)),
          )
          if (stopped) {
            for (const event of run.mapper?.closeOpenTools("Interrupted") ?? []) yield* emit(event)
            yield* emit(interruptedEvent)
          }
          yield* Queue.end(out)
        }),
      )

    const runTurn = (input: RunTurnInput): Stream.Stream<AgentEvent, AgentError> =>
      turnStream(input.threadId, (run, emit) =>
        Effect.gen(function* () {
          accessModes.set(input.threadId, input.accessMode)
          const entry = yield* getEntry(input.home)
          const { client } = entry
          const { sessionId, session } = yield* openSession(entry, input)
          yield* emit({ type: "session_bound", providerSessionId: sessionId })

          const inbox = yield* Queue.unbounded<TurnMessage>()
          yield* client.subscribe((message) => Queue.offerUnsafe(inbox, message))
          const mapper = makeUpdateMapper(randomUUID())
          Object.assign(run, { client, sessionId, mapper })

          const images = entry.capabilities.promptCapabilities?.image === true
          const blocks = yield* promptBlocks(input.prompt, input.attachments, images)
          const prompt = session.needsInstructions ? [textBlock(input.instructions), ...blocks] : blocks
          session.needsInstructions = false
          run.prompting = true
          yield* call(client, "session/prompt", { sessionId, prompt }, PromptResponse, null).pipe(
            Effect.exit,
            Effect.flatMap((exit) => Queue.offer(inbox, { kind: "prompted", exit })),
            Effect.forkScoped,
          )

          while (true) {
            const message = yield* Queue.take(inbox)
            if (message.kind === "prompted") {
              run.prompting = false
              return yield* finishTurn(mapper, message.exit, emit)
            }
            if (message.kind === "exit") {
              for (const event of mapper.closeOpenTools("Turn failed")) yield* emit(event)
              return yield* toAgentError(message.error)
            }
            if (sessionIdOf(message.params) !== sessionId) continue
            if (message.kind === "request" && message.method === "session/request_permission") {
              yield* requestPermission(input.threadId, run, message.id, message.params, emit)
            } else if (message.kind === "notification" && message.method === "session/update") {
              const notification = decodeNotification(message.params)
              if (notification._tag === "None") continue
              for (const event of mapper.apply(notification.value.update)) yield* emit(event)
            }
          }
        }),
      )

    let probedModels: ReadonlyArray<ModelInfo> | undefined
    const probeLock = yield* Semaphore.make(1)

    const listModels = Semaphore.withPermit(
      probeLock,
      Effect.gen(function* () {
        if (probedModels !== undefined) return probedModels
        const entry = yield* getEntry(null)
        const { setup } = yield* newSession(entry, homedir(), [])
        probedModels = toModelInfos(setup, config.id)
        return probedModels
      }),
    )

    const listCommands = ({ threadId }: { readonly threadId: string }) =>
      Effect.sync(() => {
        const sessionId = threadSessions.get(threadId)
        return sessionId === undefined ? [] : (current?.commands.get(sessionId) ?? [])
      })

    const interrupt = (threadId: string) =>
      Effect.suspend(() => {
        const run = runs.get(threadId)
        if (run === undefined) return Effect.void
        const { client, sessionId } = run
        if (!run.prompting || client === undefined || sessionId === undefined || !client.isAlive()) {
          return Deferred.succeed(run.stop, undefined)
        }
        return client
          .notify("session/cancel", { sessionId })
          .pipe(
            Effect.andThen(cancelPermissions(run)),
            Effect.andThen(
              Deferred.succeed(run.stop, undefined).pipe(Effect.delay(INTERRUPT_GRACE), Effect.forkIn(providerScope)),
            ),
          )
      }).pipe(Effect.asVoid)

    const closeSession = (threadId: string) =>
      Effect.gen(function* () {
        const sessionId = threadSessions.get(threadId)
        threadSessions.delete(threadId)
        accessModes.delete(threadId)
        const entry = current
        if (sessionId === undefined || entry === undefined) return
        if (entry.client.isAlive() && entry.capabilities.sessionCapabilities?.close !== undefined) {
          yield* entry.client.request("session/close", { sessionId }).pipe(Effect.ignore)
        }
        entry.sessions.delete(sessionId)
        entry.commands.delete(sessionId)
      })

    const respondApproval = (requestId: string, decision: ApprovalDecision) =>
      Effect.suspend(() => {
        const deferred = approvals.get(requestId)
        return deferred ? Deferred.succeed(deferred, decision) : Effect.void
      }).pipe(Effect.asVoid)

    const provider: AgentProvider = {
      id: config.id,
      listModels,
      account: (home) =>
        home === null ? config.account : Effect.fail(agentError(`${name} runs on its CLI login only`)),
      planLimits: () => Effect.succeed(null),
      usage: () => Effect.succeed(null),
      listCommands,
      runTurn,
      interrupt,
      closeSession,
      respondApproval,
      respondQuestion: () => Effect.void,
      setAccessMode: (threadId, accessMode) => Effect.sync(() => void accessModes.set(threadId, accessMode)),
    }
    return provider
  })
