import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { Cache, Deferred, Duration, Effect, Exit, Option, Queue, Ref, Schema, Scope, Stream } from "effect"
import type {
  AgentCommand,
  AgentEvent,
  ApprovalDecision,
  ApprovalRequest,
  ModelInfo,
  Question,
  QuestionAnswers,
  RunTurnInput,
  SessionScope,
} from "../../../shared/agent.ts"
import { AGENT_IMAGE_MAX_BYTES, AGENT_IMAGE_TYPES } from "../../../shared/agentImages.ts"
import type { AccessMode, Attachment } from "../../../shared/domain.ts"
import { providerInfo } from "../../../shared/providers.ts"
import { registerAgentPid } from "../../services/Ports.ts"
import { installedBinary } from "../binary.ts"
import { attachmentContext } from "../elementContext.ts"
import { AgentError, type AgentProvider, interruptedTurn, tmpEnv } from "../provider.ts"
import { type Incoming, makePiClient, type PiClient, type PiFailure } from "./client.ts"
import { displayName, type EventMapper, makeEventMapper, type PiToolCall, stringArg, toolInput } from "./events.ts"
import extensionSource from "./extension.mjs?raw"
import { modelArgs, toModelInfo } from "./models.ts"
import { AgentSettled, Commands, Models, State, UiRequest } from "./protocol.ts"

const INTERRUPT_GRACE = Duration.seconds(5)
const APPROVE_PREFIX = "hinacode:approve "
const READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls"])
const EDIT_TOOLS = new Set(["edit", "write"])
const QUESTION_METHODS = new Set(["select", "confirm", "input", "editor"])
const YES = "Yes"
const NO = "No"

const decodeUiRequest = Schema.decodeUnknownOption(UiRequest)
const decodeSettled = Schema.decodeUnknownOption(AgentSettled)

interface PendingUi {
  readonly approvalId?: string
}

interface Run {
  readonly stop: Deferred.Deferred<void>
  readonly ui: Map<string, PendingUi>
  readonly cwd: string
  client?: PiClient
  mapper?: EventMapper
  prompting: boolean
}

interface PiImage {
  readonly type: "image"
  readonly data: string
  readonly mimeType: string
}

const allows = (mode: AccessMode, toolName: string) =>
  mode === "full" || READ_ONLY_TOOLS.has(toolName) || (mode === "auto" && EDIT_TOOLS.has(toolName))

const sessionScope = (call: PiToolCall): SessionScope => {
  const tool = displayName(call.name)
  const command = call.name === "bash" ? stringArg(call.args, "command") : undefined
  return command === undefined ? { tool, kind: "tool", value: tool } : { tool, kind: "command", value: command }
}

const grantKey = (scope: SessionScope) => JSON.stringify([scope.tool, scope.kind, scope.value])

const describe = (call: PiToolCall): Pick<ApprovalRequest, "kind" | "title" | "detail"> => {
  const path = stringArg(call.args, "path") ?? ""
  switch (call.name) {
    case "bash":
      return { kind: "command", title: "Run command", detail: stringArg(call.args, "command") ?? "" }
    case "edit":
      return { kind: "patch", title: "Edit file", detail: path }
    case "write":
      return { kind: "patch", title: "Write file", detail: path }
    default:
      return { kind: "tool", title: displayName(call.name), detail: path || JSON.stringify(call.args) }
  }
}

const toQuestion = (request: UiRequest): Question => {
  const title = request.title ?? ""
  const base = { id: request.id, header: "", multiSelect: false, secret: false }
  switch (request.method) {
    case "select":
      return {
        ...base,
        question: title,
        options: (request.options ?? []).map((label) => ({ label, description: "" })),
        allowsText: false,
      }
    case "confirm":
      return {
        ...base,
        question: request.message === undefined ? title : `${title}\n\n${request.message}`,
        options: [YES, NO].map((label) => ({ label, description: "" })),
        allowsText: false,
      }
    default:
      return { ...base, question: title, options: [], allowsText: true }
  }
}

const uiAnswer = (request: UiRequest, values: ReadonlyArray<string>) => {
  const first = values[0]
  if (first === undefined) return { cancelled: true }
  switch (request.method) {
    case "confirm":
      return { confirmed: first === YES }
    case "select":
      return { value: first }
    default:
      return { value: values.join("\n") }
  }
}

const lostSession = /No session found matching|Session found in different project/

const agentError = (message: string) => new AgentError({ provider: "pi", message })

const promptParts = (text: string, attachments: ReadonlyArray<Attachment>) =>
  Effect.forEach(
    attachments,
    (
      attachment,
    ): Effect.Effect<
      { readonly texts: ReadonlyArray<string>; readonly images: ReadonlyArray<PiImage> },
      AgentError
    > => {
      const fitsImage =
        attachment.kind === "image" &&
        AGENT_IMAGE_TYPES.includes(attachment.mime) &&
        attachment.bytes <= AGENT_IMAGE_MAX_BYTES
      if (!fitsImage) return Effect.succeed({ texts: [`Attached file: ${attachment.path}`], images: [] })
      return Effect.tryPromise({
        try: () => readFile(attachment.path),
        catch: (cause) => agentError(`Failed to read ${attachment.name}: ${String(cause)}`),
      }).pipe(
        Effect.map((data) => {
          const context = attachmentContext(attachment)
          return {
            texts: context === null ? [] : [context],
            images: [{ type: "image", data: data.toString("base64"), mimeType: attachment.mime }],
          }
        }),
      )
    },
  ).pipe(
    Effect.map((parts) => ({
      message: [...(text === "" ? [] : [text]), ...parts.flatMap((part) => part.texts)].join("\n\n"),
      images: parts.flatMap((part) => part.images),
    })),
  )

const makeExtensionFile = Effect.acquireRelease(
  Effect.sync(() => {
    const dir = mkdtempSync(join(tmpdir(), "hinacode-pi-"))
    return { dir, path: join(dir, "hinacode.mjs") }
  }),
  ({ dir }) => Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
)

export const makePiProvider: Effect.Effect<AgentProvider, never, Scope.Scope> = Effect.gen(function* () {
  const providerScope = yield* Effect.scope
  const { name, binary } = providerInfo.pi
  const extension = yield* makeExtensionFile

  const extensionPath = Effect.sync(() => {
    if (existsSync(extension.path)) return extension.path
    mkdirSync(extension.dir, { recursive: true, mode: 0o700 })
    const staged = `${extension.path}.${randomUUID()}`
    writeFileSync(staged, extensionSource)
    renameSync(staged, extension.path)
    return extension.path
  })

  const toAgentError = (failure: PiFailure) => {
    switch (failure._tag) {
      case "PiCommandError":
        return agentError(`${name} ${failure.command} failed: ${failure.message}`)
      case "PiTimeout":
        return agentError(`${name} did not answer ${failure.command} within ${failure.after}`)
      case "PiExit":
        return agentError(failure.message)
    }
  }

  const query = <A>(client: PiClient, command: string, schema: Schema.Decoder<A>) =>
    client.command(command).pipe(
      Effect.mapError(toAgentError),
      Effect.flatMap((data) =>
        Schema.decodeUnknownEffect(schema)(data).pipe(
          Effect.mapError(() => agentError(`${name} sent an invalid ${command} response`)),
        ),
      ),
    )

  const startPi = (options: {
    readonly args: ReadonlyArray<string>
    readonly cwd: string
    readonly env?: NodeJS.ProcessEnv
  }) =>
    Effect.gen(function* () {
      const binaryPath = yield* installedBinary("pi", binary)
      return yield* makePiClient({
        binaryPath,
        args: ["--mode", "rpc", "--approve", ...options.args],
        cwd: options.cwd,
        env: { ...process.env, ...options.env },
      })
    })

  const runs = new Map<string, Run>()
  const accessModes = new Map<string, AccessMode>()
  const grants = new Map<string, Set<string>>()
  const approvals = new Map<string, Deferred.Deferred<ApprovalDecision>>()
  const questions = new Map<string, Deferred.Deferred<QuestionAnswers>>()

  const grantsOf = (threadId: string) => {
    const existing = grants.get(threadId)
    if (existing !== undefined) return existing
    const created = new Set<string>()
    grants.set(threadId, created)
    return created
  }

  const answerUi = (run: Run, id: string, answer: object) =>
    Effect.suspend(() => {
      const pending = run.ui.get(id)
      if (pending === undefined || run.client === undefined) return Effect.void
      run.ui.delete(id)
      if (pending.approvalId !== undefined) approvals.delete(pending.approvalId)
      questions.delete(id)
      return run.client.send({ type: "extension_ui_response", id, ...answer })
    })

  const cancelUi = (run: Run) =>
    Effect.forEach([...run.ui.keys()], (id) => answerUi(run, id, { cancelled: true }), { discard: true })

  const requestApproval = (
    threadId: string,
    run: Run,
    request: UiRequest,
    toolCallId: string,
    mapper: EventMapper,
    emit: (event: AgentEvent) => Effect.Effect<boolean>,
  ) =>
    Effect.gen(function* () {
      const call = mapper.tool(toolCallId) ?? { name: "tool", args: {} }
      const scope = sessionScope(call)
      run.ui.set(request.id, {})
      if (allows(accessModes.get(threadId) ?? "supervised", call.name) || grantsOf(threadId).has(grantKey(scope))) {
        return yield* answerUi(run, request.id, { value: "allow" })
      }
      const approvalId = randomUUID()
      const decision = yield* Deferred.make<ApprovalDecision>()
      approvals.set(approvalId, decision)
      run.ui.set(request.id, { approvalId })
      yield* emit({
        type: "approval_requested",
        request: {
          id: approvalId,
          threadId,
          provider: "pi",
          ...describe(call),
          input: toolInput(call, run.cwd),
          sessionScope: scope,
        },
      })
      yield* Deferred.await(decision).pipe(
        Effect.flatMap((chosen) =>
          Effect.sync(() => chosen === "allow_for_session" && grantsOf(threadId).add(grantKey(scope))).pipe(
            Effect.andThen(answerUi(run, request.id, { value: chosen === "deny" ? "deny" : "allow" })),
            Effect.andThen(emit({ type: "approval_resolved", requestId: approvalId })),
          ),
        ),
        Effect.forkScoped,
      )
    })

  const askQuestion = (
    threadId: string,
    run: Run,
    request: UiRequest,
    emit: (event: AgentEvent) => Effect.Effect<boolean>,
  ) =>
    Effect.gen(function* () {
      const answers = yield* Deferred.make<QuestionAnswers>()
      questions.set(request.id, answers)
      run.ui.set(request.id, {})
      const question = toQuestion(request)
      yield* emit({
        type: "question_requested",
        request: { id: request.id, threadId, provider: "pi", questions: [question] },
      })
      yield* Deferred.await(answers).pipe(
        Effect.flatMap((chosen) =>
          answerUi(run, request.id, uiAnswer(request, chosen[question.id] ?? [])).pipe(
            Effect.andThen(emit({ type: "question_resolved", requestId: request.id })),
          ),
        ),
        Effect.forkScoped,
      )
    })

  const handleUi = (
    threadId: string,
    run: Run,
    raw: unknown,
    mapper: EventMapper,
    emit: (event: AgentEvent) => Effect.Effect<boolean>,
  ) =>
    Effect.suspend(() => {
      const decoded = decodeUiRequest(raw)
      if (Option.isNone(decoded)) return Effect.void
      const request = decoded.value
      if (request.method === "select" && request.title?.startsWith(APPROVE_PREFIX)) {
        const toolCallId = request.title.slice(APPROVE_PREFIX.length)
        return requestApproval(threadId, run, request, toolCallId, mapper, emit)
      }
      return QUESTION_METHODS.has(request.method) ? askQuestion(threadId, run, request, emit) : Effect.void
    })

  const turnStream = (
    input: RunTurnInput,
    follow: (
      run: Run,
      emit: (event: AgentEvent) => Effect.Effect<boolean>,
    ) => Effect.Effect<void, AgentError, Scope.Scope>,
  ) =>
    Stream.callback<AgentEvent, AgentError>((out) =>
      Effect.gen(function* () {
        const emit = (event: AgentEvent) => Queue.offer(out, event)
        const run: Run = { stop: yield* Deferred.make<void>(), ui: new Map(), cwd: input.cwd, prompting: false }
        runs.set(input.threadId, run)
        yield* Effect.addFinalizer(() =>
          cancelUi(run).pipe(
            Effect.andThen(Effect.sync(() => runs.get(input.threadId) === run && runs.delete(input.threadId))),
          ),
        )
        const stopped = yield* Effect.raceFirst(
          follow(run, emit).pipe(Effect.as(false)),
          Deferred.await(run.stop).pipe(Effect.as(true)),
        )
        if (stopped) {
          for (const event of run.mapper?.closeOpenTools("Interrupted") ?? []) yield* emit(event)
          yield* emit(interruptedTurn)
        }
        yield* Queue.end(out)
      }),
    )

  const runTurn = (input: RunTurnInput): Stream.Stream<AgentEvent, AgentError> =>
    turnStream(input, (run, emit) =>
      Effect.gen(function* () {
        if (input.home !== null) return yield* agentError(`${name} runs on its CLI login only`)
        accessModes.set(input.threadId, input.accessMode)
        const client = yield* startPi({
          args: [
            "-e",
            yield* extensionPath,
            ...modelArgs(input.model),
            ...(input.effort === null ? [] : ["--thinking", input.effort]),
            ...(input.resumeSessionId === null ? [] : ["--session", input.resumeSessionId]),
            "--append-system-prompt",
            input.instructions,
          ],
          cwd: input.cwd,
          env: {
            HINACODE_MCP_URL: input.mcpServer.url,
            HINACODE_MCP_AUTHORIZATION: input.mcpServer.headers.authorization,
            ...tmpEnv(input.tmpDirectory),
          },
        })
        yield* Effect.acquireRelease(
          Effect.sync(() => registerAgentPid(input.threadId, client.pid)),
          (unregister) => Effect.sync(unregister),
        )
        const inbox = yield* Queue.unbounded<Incoming>()
        yield* client.subscribe((message) => Queue.offerUnsafe(inbox, message))

        const state = yield* client.command("get_state").pipe(
          Effect.map((data) => ({ lost: null, data })),
          Effect.catchTag("PiExit", (exit) =>
            lostSession.test(exit.output) ? Effect.succeed({ lost: exit.output, data: null }) : Effect.fail(exit),
          ),
          Effect.mapError(toAgentError),
        )
        if (state.lost !== null) {
          const reason =
            state.lost
              .split("\n")
              .find((line) => lostSession.test(line))
              ?.trim() ?? state.lost
          return yield* emit({
            type: "turn_failed",
            message: `${reason}\n\nYour next message starts a new ${name} session.`,
            sessionLost: true,
          })
        }
        const { sessionId, model } = yield* Schema.decodeUnknownEffect(State)(state.data).pipe(
          Effect.mapError(() => agentError(`${name} sent an invalid get_state response`)),
        )
        yield* emit({ type: "session_bound", providerSessionId: sessionId })

        const mapper = makeEventMapper(input.cwd)
        Object.assign(run, { client, mapper })
        const { message, images } = yield* promptParts(input.prompt, input.attachments)
        yield* client
          .command("prompt", { message, ...(images.length > 0 && { images }) })
          .pipe(Effect.mapError(toAgentError))
        run.prompting = true
        yield* input.onOpen ?? Effect.void

        while (true) {
          const incoming = yield* Queue.take(inbox)
          if (incoming.kind === "exit") {
            for (const event of mapper.closeOpenTools("Turn failed")) yield* emit(event)
            return yield* toAgentError(incoming.error)
          }
          const settled = decodeSettled(incoming.event)
          if (Option.isSome(settled)) {
            run.prompting = false
            yield* cancelUi(run)
            for (const event of mapper.settle(settled.value.aborted, model?.contextWindow ?? null)) yield* emit(event)
            return
          }
          for (const event of mapper.apply(incoming.event)) yield* emit(event)
          yield* handleUi(input.threadId, run, incoming.event, mapper, emit)
        }
      }),
    )

  const steer = (threadId: string, text: string, attachments: ReadonlyArray<Attachment>) =>
    Effect.gen(function* () {
      const run = runs.get(threadId)
      const client = run?.client
      if (run === undefined || client === undefined || !run.prompting || !client.isAlive()) return false
      const { message, images } = yield* promptParts(text, attachments)
      yield* client
        .command("steer", { message, ...(images.length > 0 && { images }) })
        .pipe(Effect.mapError(toAgentError))
      return true
    })

  const interrupt = (threadId: string) =>
    Effect.suspend(() => {
      const run = runs.get(threadId)
      if (run === undefined) return Effect.void
      const { client } = run
      if (!run.prompting || client === undefined || !client.isAlive()) return Deferred.succeed(run.stop, undefined)
      return client
        .send({ type: "clear_queue" })
        .pipe(
          Effect.andThen(client.send({ type: "abort" })),
          Effect.andThen(cancelUi(run)),
          Effect.andThen(
            Deferred.succeed(run.stop, undefined).pipe(Effect.delay(INTERRUPT_GRACE), Effect.forkIn(providerScope)),
          ),
        )
    }).pipe(Effect.asVoid)

  const probeModels = Effect.gen(function* () {
    const client = yield* startPi({ args: ["--no-session"], cwd: homedir() })
    const state = yield* query(client, "get_state", State)
    const { models } = yield* query(client, "get_available_models", Models)
    const current = state.model
    const isCurrent = (model: (typeof models)[number]) =>
      current != null && model.provider === current.provider && model.id === current.id
    return [...models.filter(isCurrent), ...models.filter((model) => !isCurrent(model))].map(toModelInfo)
  }).pipe(Effect.scoped)

  const lastModels = yield* Ref.make<ReadonlyArray<ModelInfo>>([])
  const freshModels = yield* Effect.cachedWithTTL(
    probeModels.pipe(Effect.tap((models) => (models.length > 0 ? Ref.set(lastModels, models) : Effect.void))),
    (exit) => (Exit.isSuccess(exit) && exit.value.length > 0 ? Duration.minutes(10) : Duration.zero),
  )
  const listModels = Effect.gen(function* () {
    const last = yield* Ref.get(lastModels)
    if (last.length === 0) return yield* freshModels
    yield* freshModels.pipe(
      Effect.ignore({ log: "Warn", message: `${name} model refresh failed` }),
      Effect.forkIn(providerScope),
    )
    return last
  })

  const probeCommands = (cwd: string) =>
    Effect.gen(function* () {
      const client = yield* startPi({ args: ["--no-session"], cwd })
      const { commands } = yield* query(client, "get_commands", Commands)
      return commands.map((command): AgentCommand => ({
        trigger: "/",
        name: command.name,
        description: command.description ?? "",
        argumentHint: "",
      }))
    }).pipe(Effect.scoped)

  const probedCommands = yield* Cache.makeWith(probeCommands, {
    capacity: 32,
    timeToLive: (exit) => (Exit.isSuccess(exit) ? Duration.minutes(1) : Duration.zero),
  })

  const respondApproval = (requestId: string, decision: ApprovalDecision) =>
    Effect.suspend(() => {
      const deferred = approvals.get(requestId)
      return deferred ? Deferred.succeed(deferred, decision).pipe(Effect.as(false)) : Effect.succeed(false)
    })

  const respondQuestion = (requestId: string, answers: QuestionAnswers) =>
    Effect.suspend(() => {
      const deferred = questions.get(requestId)
      return deferred ? Deferred.succeed(deferred, answers) : Effect.void
    }).pipe(Effect.asVoid)

  const provider: AgentProvider = {
    id: "pi",
    listModels,
    account: (home) =>
      home === null
        ? installedBinary("pi", binary).pipe(Effect.as({ type: "external", service: "pi" } as const))
        : Effect.fail(agentError(`${name} runs on its CLI login only`)),
    planLimits: () => Effect.succeed(null),
    usage: () => Effect.succeed(null),
    listCommands: ({ cwd }) => Cache.get(probedCommands, cwd),
    runTurn,
    steer,
    interrupt,
    respondApproval,
    respondQuestion,
    setAccessMode: (threadId, accessMode) => Effect.sync(() => void accessModes.set(threadId, accessMode)),
  }
  return provider
})
