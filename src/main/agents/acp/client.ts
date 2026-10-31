import { spawn } from "node:child_process"
import { createInterface } from "node:readline"
import { Deferred, Duration, Effect, Option, Schema, Scope } from "effect"

export type RequestId = number | string

export type Incoming =
  | { readonly kind: "notification"; readonly method: string; readonly params: unknown }
  | { readonly kind: "request"; readonly id: RequestId; readonly method: string; readonly params: unknown }
  | { readonly kind: "exit"; readonly error: AcpExit }

export class AcpCallError extends Schema.TaggedError<AcpCallError>()("AcpCallError", {
  method: Schema.String,
  code: Schema.Number,
  message: Schema.String,
  detail: Schema.NullOr(Schema.String),
}) {}

export class AcpExit extends Schema.TaggedError<AcpExit>()("AcpExit", {
  message: Schema.String,
}) {}

export class AcpTimeout extends Schema.TaggedError<AcpTimeout>()("AcpTimeout", {
  method: Schema.String,
  after: Schema.String,
}) {}

export type AcpFailure = AcpCallError | AcpExit | AcpTimeout

const WireMessage = Schema.Struct({
  id: Schema.optional(Schema.NullOr(Schema.Union([Schema.Number, Schema.String]))),
  method: Schema.optional(Schema.String),
  params: Schema.optional(Schema.Unknown),
  result: Schema.optional(Schema.Unknown),
  error: Schema.optional(
    Schema.Struct({ code: Schema.Number, message: Schema.String, data: Schema.optional(Schema.Unknown) }),
  ),
})
const decodeWireMessage = Schema.decodeUnknownOption(Schema.fromJsonString(WireMessage))

const errorDetail = (data: unknown) => {
  if (typeof data === "string") return data
  const message = typeof data === "object" && data !== null ? Reflect.get(data, "message") : undefined
  return typeof message === "string" ? message : null
}

export interface AcpClient {
  readonly isAlive: () => boolean
  readonly request: (
    method: string,
    params: unknown,
    timeout?: Duration.Duration | null,
  ) => Effect.Effect<unknown, AcpFailure>
  readonly notify: (method: string, params: unknown) => Effect.Effect<void>
  readonly respond: (id: RequestId, result: unknown) => Effect.Effect<void>
  readonly respondError: (id: RequestId, code: number, message: string) => Effect.Effect<void>
  readonly subscribe: (listener: (message: Incoming) => void) => Effect.Effect<void, never, Scope.Scope>
}

const REQUEST_TIMEOUT = Duration.seconds(60)

export const makeAcpClient = (options: {
  readonly binaryPath: string
  readonly args: ReadonlyArray<string>
  readonly env: NodeJS.ProcessEnv
}) =>
  Effect.gen(function* () {
    const child = yield* Effect.acquireRelease(
      Effect.sync(() =>
        spawn(options.binaryPath, [...options.args], { env: options.env, stdio: ["pipe", "pipe", "pipe"] }),
      ),
      (proc) => Effect.sync(() => proc.kill()),
    )
    const command = [options.binaryPath, ...options.args].join(" ")

    const pending = new Map<
      RequestId,
      { readonly method: string; readonly answer: Deferred.Deferred<unknown, AcpFailure> }
    >()
    const listeners = new Set<(message: Incoming) => void>()
    let nextId = 1
    let exitError: AcpExit | undefined
    let stderrTail = ""

    const write = (message: object) => {
      if (exitError === undefined) child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`)
    }

    const handleExit = (error: AcpExit) => {
      if (exitError !== undefined) return
      exitError = error
      for (const { answer } of pending.values()) Deferred.doneUnsafe(answer, Effect.fail(error))
      pending.clear()
      for (const listener of listeners) listener({ kind: "exit", error })
    }

    child.on("error", (error) => handleExit(new AcpExit({ message: `${command} failed to start: ${error.message}` })))
    child.on("exit", (code, signal) =>
      handleExit(new AcpExit({ message: `${command} exited (code ${code}, signal ${signal}). ${stderrTail.trim()}` })),
    )
    child.stdin.on("error", () => {})
    child.stderr.on("data", (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-2000)
    })

    createInterface({ input: child.stdout }).on("line", (line) => {
      const decoded = decodeWireMessage(line)
      if (Option.isNone(decoded)) return
      const message = decoded.value
      if (message.method !== undefined) {
        const incoming: Incoming =
          message.id == null
            ? { kind: "notification", method: message.method, params: message.params }
            : { kind: "request", id: message.id, method: message.method, params: message.params }
        for (const listener of listeners) listener(incoming)
        return
      }
      if (message.id == null) return
      const waiting = pending.get(message.id)
      if (waiting === undefined) return
      pending.delete(message.id)
      const { error } = message
      Deferred.doneUnsafe(
        waiting.answer,
        error
          ? Effect.fail(
              new AcpCallError({
                method: waiting.method,
                code: error.code,
                message: error.message,
                detail: errorDetail(error.data),
              }),
            )
          : Effect.succeed(message.result),
      )
    })

    const request = (
      method: string,
      params: unknown,
      timeout: Duration.Duration | null = REQUEST_TIMEOUT,
    ): Effect.Effect<unknown, AcpFailure> =>
      Effect.suspend(() => {
        if (exitError !== undefined) return Effect.fail(exitError)
        const id = nextId++
        const answer = Deferred.makeUnsafe<unknown, AcpFailure>()
        pending.set(id, { method, answer })
        write({ id, method, params })
        const awaited = Deferred.await(answer).pipe(Effect.onInterrupt(() => Effect.sync(() => pending.delete(id))))
        if (timeout === null) return awaited
        return awaited.pipe(
          Effect.timeoutOrElse({
            duration: timeout,
            orElse: () => Effect.fail(new AcpTimeout({ method, after: Duration.format(timeout) })),
          }),
        )
      })

    const client: AcpClient = {
      isAlive: () => exitError === undefined,
      request,
      notify: (method, params) => Effect.sync(() => write({ method, params })),
      respond: (id, result) => Effect.sync(() => write({ id, result })),
      respondError: (id, code, message) => Effect.sync(() => write({ id, error: { code, message } })),
      subscribe: (listener) =>
        Effect.acquireRelease(
          Effect.sync(() => {
            listeners.add(listener)
            if (exitError !== undefined) listener({ kind: "exit", error: exitError })
          }),
          () => Effect.sync(() => listeners.delete(listener)),
        ),
    }
    return client
  })
