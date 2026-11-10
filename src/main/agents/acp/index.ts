import { randomUUID } from "node:crypto"
import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { Cache, Deferred, Duration, Effect, Exit, Queue, Schema, Scope, Semaphore, Stream } from "effect"
import type {
  AgentAccount,
  AgentCommand,
  AgentEvent,
  ApprovalDecision,
  ModelInfo,
  ProviderId,
  RunTurnInput,
} from "../../../shared/agent.ts"
import { AGENT_IMAGE_MAX_BYTES, AGENT_IMAGE_TYPES } from "../../../shared/agentImages.ts"
import type { AccessMode, Attachment } from "../../../shared/domain.ts"
import { providerInfo } from "../../../shared/providers.ts"
import { registerAgentPid } from "../../services/Ports.ts"
import { installedBinary } from "../binary.ts"
import { attachmentContext } from "../elementContext.ts"
import { AgentError, type AgentProvider } from "../provider.ts"
import { autoAllows, mergePermissionTool, optionFor, permissionOutcome, toApprovalRequest } from "./approvals.ts"
import { type AcpClient, type AcpFailure, type Incoming, makeAcpClient, type RequestId } from "./client.ts"
import { AGENT_DEFAULT_EFFORT, effortLevels, effortSelector, modelSelector, toModelInfos } from "./models.ts"
import {
  AvailableCommandsUpdate,
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
  readonly loginCommand: string
  readonly account: Effect.Effect<AgentAccount, AgentError>
}

const CLIENT_VERSION = "0.1.0"
const INITIALIZE_TIMEOUT = Duration.seconds(30)
const INTERRUPT_GRACE = Duration.seconds(5)
const COMMANDS_WAIT = Duration.seconds(5)

const interruptedEvent: AgentEvent = { type: "turn_failed", message: "Turn interrupted" }

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
  | {
      readonly type: "text"
      readonly text: string
      readonly annotations?: { readonly audience: ReadonlyArray<string> }
    }
  | { readonly type: "image"; readonly data: string; readonly mimeType: string }

const textBlock = (text: string): ContentBlock => ({ type: "text", text })

const instructionsBlock = (text: string): ContentBlock => ({
  type: "text",
  text,
  annotations: { audience: ["assistant"] },
})

type TurnMessage = Incoming | { readonly kind: "prompted"; readonly exit: Exit.Exit<PromptResponse, AgentError> }

const decodeNotification = Schema.decodeUnknownOption(SessionNotification)
const decodeCommands = Schema.decodeUnknownOption(AvailableCommandsUpdate)
const decodePermission = Schema.decodeUnknownOption(RequestPermissionParams)

const commandsOf = (message: Incoming) => {
  if (message.kind !== "notification" || message.method !== "session/update") return undefined
  const notification = decodeNotification(message.params)
  if (notification._tag === "None") return undefined
  const update = decodeCommands(notification.value.update)
  if (update._tag === "None") return undefined
  return update.value.availableCommands.map((command): AgentCommand => ({
    trigger: "/",
    name: command.name,
    description: command.description ?? "",
    argumentHint: command.input?.hint ?? "",
  }))
}

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
    const { name } = providerInfo[config.id]
    const agentError = (message: string) => new AgentError({ provider: config.id, message })

    const signedOut = new AgentError({
      provider: config.id,
      message: `${name} is not signed in`,
      loginCommand: config.loginCommand,
    })

    const toAgentError = (failure: AcpFailure) => {
      if (isAuthRequired(failure)) return signedOut
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

    const runs = new Map<string, Run>()
    const accessModes = new Map<string, AccessMode>()
    const approvals = new Map<string, Deferred.Deferred<ApprovalDecision>>()
    const commands = new Map<string, ReadonlyArray<AgentCommand>>()

    const runOfSession = (sessionId: string) => [...runs.values()].find((run) => run.sessionId === sessionId)

    const trackCommands = (threadId: string, message: Incoming) => {
      const announced = commandsOf(message)
      if (announced !== undefined) commands.set(threadId, announced)
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

    const startAgent = Effect.gen(function* () {
      const binaryPath = config.binary ?? (yield* installedBinary(config.id, providerInfo[config.id].binary))
      const client = yield* makeAcpClient({ binaryPath, args: config.args, env: { ...process.env, ...config.env } })
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
      return { client, capabilities: initialized.agentCapabilities ?? {} }
    })

    const openSession = (client: AcpClient, input: RunTurnInput) => {
      const { resumeSessionId: sessionId, cwd } = input
      const servers = mcpServers(input)
      if (sessionId === null) {
        return call(client, "session/new", { cwd, mcpServers: servers }, NewSessionResponse).pipe(
          Effect.map((created) => ({ sessionId: created.sessionId, setup: created, isNew: true })),
        )
      }
      return call(client, "session/load", { sessionId, cwd, mcpServers: servers }, SessionSetup).pipe(
        Effect.map((loaded) => ({ sessionId, setup: loaded, isNew: false })),
      )
    }

    const setOption = (client: AcpClient, sessionId: string, configId: string, value: string) =>
      call(client, "session/set_config_option", { sessionId, configId, value }, SessionSetup)

    const selectModel = (client: AcpClient, sessionId: string, setup: SessionSetup, model: string) => {
      const selector = modelSelector(setup)
      if (model === "" || selector === null || selector.current === model) return Effect.succeed(setup)
      return selector.via === "config"
        ? setOption(client, sessionId, selector.configId, model)
        : call(client, "session/set_model", { sessionId, modelId: model }, Schema.Unknown).pipe(Effect.as(setup))
    }

    const selectEffort = (client: AcpClient, sessionId: string, setup: SessionSetup, input: RunTurnInput) => {
      const selector = effortSelector(setup)
      const wanted = input.effort ?? AGENT_DEFAULT_EFFORT
      if (selector === null || !selector.levels.includes(wanted)) {
        if (input.effort === null) return Effect.void
        const offered = selector === null ? "none" : effortLevels(setup).join(", ")
        return Effect.fail(agentError(`${input.model} has no ${input.effort} effort. Its levels: ${offered}.`))
      }
      return selector.current === wanted ? Effect.void : setOption(client, sessionId, selector.configId, wanted)
    }

    const promptBlocks = (text: string, attachments: ReadonlyArray<Attachment>, images: boolean) =>
      Effect.forEach(attachments, (attachment): Effect.Effect<ReadonlyArray<ContentBlock>, AgentError> => {
        const fitsImage =
          images &&
          attachment.kind === "image" &&
          AGENT_IMAGE_TYPES.includes(attachment.mime) &&
          attachment.bytes <= AGENT_IMAGE_MAX_BYTES
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
          if (input.home !== null) return yield* agentError(`${name} runs on its CLI login only`)
          accessModes.set(input.threadId, input.accessMode)
          const { client, capabilities } = yield* startAgent
          yield* Effect.acquireRelease(
            Effect.sync(() => registerAgentPid(input.threadId, client.pid)),
            (unregister) => Effect.sync(unregister),
          )
          yield* client.subscribe((message) => {
            trackCommands(input.threadId, message)
            answerUnowned(client, message)
          })
          const { sessionId, setup, isNew } = yield* openSession(client, input)
          yield* emit({ type: "session_bound", providerSessionId: sessionId })
          const selected = yield* selectModel(client, sessionId, setup, input.model)
          yield* selectEffort(client, sessionId, selected, input)

          const inbox = yield* Queue.unbounded<TurnMessage>()
          yield* client.subscribe((message) => Queue.offerUnsafe(inbox, message))
          const mapper = makeUpdateMapper(randomUUID())
          Object.assign(run, { client, sessionId, mapper })

          const images = capabilities.promptCapabilities?.image === true
          const blocks = yield* promptBlocks(input.prompt, input.attachments, images)
          const prompt = isNew ? [instructionsBlock(input.instructions), ...blocks] : blocks
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
        const { client } = yield* startAgent
        const probe = yield* call(client, "session/new", { cwd: homedir(), mcpServers: [] }, NewSessionResponse)
        const selector = modelSelector(probe)
        const efforts = new Map<string, ReadonlyArray<string>>()
        if (selector?.via === "config") {
          for (const { id } of toModelInfos(probe, config.id)) {
            const selected = yield* setOption(client, probe.sessionId, selector.configId, id).pipe(Effect.option)
            if (selected._tag === "Some") efforts.set(id, effortLevels(selected.value))
          }
        }
        probedModels = toModelInfos(probe, config.id, efforts)
        return probedModels
      }).pipe(Effect.scoped),
    )

    const probeCommands = (cwd: string) =>
      Effect.gen(function* () {
        const { client } = yield* startAgent
        const announced = yield* Deferred.make<ReadonlyArray<AgentCommand>>()
        yield* client.subscribe((message) => {
          const update = commandsOf(message)
          if (update !== undefined) Deferred.doneUnsafe(announced, Effect.succeed(update))
        })
        yield* call(client, "session/new", { cwd, mcpServers: [] }, NewSessionResponse)
        return yield* Deferred.await(announced).pipe(
          Effect.timeoutOrElse({ duration: COMMANDS_WAIT, orElse: () => Effect.succeed([]) }),
        )
      }).pipe(Effect.scoped)

    const probedCommands = yield* Cache.make({ lookup: probeCommands, capacity: 32, timeToLive: Duration.minutes(1) })

    const listCommands = ({ threadId, cwd }: { readonly threadId: string; readonly cwd: string }) =>
      Effect.suspend(() => {
        const tracked = commands.get(threadId)
        return tracked === undefined ? Cache.get(probedCommands, cwd) : Effect.succeed(tracked)
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

    const respondApproval = (requestId: string, decision: ApprovalDecision) =>
      Effect.suspend(() => {
        const deferred = approvals.get(requestId)
        return deferred ? Deferred.succeed(deferred, decision).pipe(Effect.as(false)) : Effect.succeed(false)
      })

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
      respondApproval,
      respondQuestion: () => Effect.void,
      setAccessMode: (threadId, accessMode) => Effect.sync(() => void accessModes.set(threadId, accessMode)),
    }
    return provider
  })
