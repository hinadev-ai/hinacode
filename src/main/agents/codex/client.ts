import { spawn } from "node:child_process"
import { createInterface } from "node:readline"
import { Deferred, Duration, Effect, Scope } from "effect"
import { AgentError } from "../provider.ts"
import type { InitializeParams, RequestId } from "./protocol.ts"

export type Incoming =
  | { readonly kind: "notification"; readonly method: string; readonly params: unknown }
  | { readonly kind: "request"; readonly id: RequestId; readonly method: string; readonly params: unknown }
  | { readonly kind: "exit"; readonly error: AgentError }

type WireMessage = {
  id?: RequestId
  method?: string
  params?: unknown
  result?: unknown
  error?: { code: number; message?: string }
}

export interface CodexClient {
  readonly isAlive: () => boolean
  /** Fails if the app-server does not answer in time. Only control calls are requests; turn output arrives as notifications. */
  readonly request: <A = unknown>(method: string, params: unknown) => Effect.Effect<A, AgentError>
  readonly respond: (id: RequestId, result: unknown) => Effect.Effect<void>
  readonly respondError: (id: RequestId, code: number, message: string) => Effect.Effect<void>
  /** Receives every server notification, server request, and process exit until the scope closes. */
  readonly subscribe: (listener: (message: Incoming) => void) => Effect.Effect<void, never, Scope.Scope>
}

const codexError = (message: string) => new AgentError({ provider: "codex", message })

const REQUEST_TIMEOUT = Duration.seconds(60)
const INITIALIZE_TIMEOUT = Duration.seconds(30)

/**
 * Spawns `codex app-server` and performs the initialize handshake.
 * The process is killed when the scope closes.
 * Wire format: newline-delimited JSON-RPC 2.0 without the "jsonrpc" field.
 */
export const makeCodexClient = (options: { readonly binaryPath: string; readonly clientVersion: string }) =>
  Effect.gen(function* () {
    const child = yield* Effect.acquireRelease(
      Effect.sync(() => spawn(options.binaryPath, ["app-server"], { stdio: ["pipe", "pipe", "pipe"] })),
      (proc) => Effect.sync(() => proc.kill()),
    )

    const pending = new Map<RequestId, Deferred.Deferred<unknown, AgentError>>()
    const listeners = new Set<(message: Incoming) => void>()
    let nextId = 1
    let exitError: AgentError | undefined
    let stderrTail = ""

    const write = (message: object) => {
      if (exitError === undefined) child.stdin.write(`${JSON.stringify(message)}\n`)
    }

    const handleExit = (error: AgentError) => {
      if (exitError !== undefined) return
      exitError = error
      for (const deferred of pending.values()) Deferred.doneUnsafe(deferred, Effect.fail(error))
      pending.clear()
      for (const listener of listeners) listener({ kind: "exit", error })
    }

    child.on("error", (error) => handleExit(codexError(`codex app-server failed to start: ${error.message}`)))
    child.on("exit", (code, signal) =>
      handleExit(codexError(`codex app-server exited (code ${code}, signal ${signal}). ${stderrTail.trim()}`)),
    )
    child.stdin.on("error", () => {})
    child.stderr.on("data", (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-2000)
    })

    createInterface({ input: child.stdout }).on("line", (line) => {
      let message: WireMessage
      try {
        message = JSON.parse(line)
      } catch {
        return
      }
      if (typeof message.method === "string") {
        const incoming: Incoming =
          message.id === undefined
            ? { kind: "notification", method: message.method, params: message.params }
            : { kind: "request", id: message.id, method: message.method, params: message.params }
        for (const listener of listeners) listener(incoming)
        return
      }
      const deferred = message.id === undefined ? undefined : pending.get(message.id)
      if (deferred === undefined) return
      pending.delete(message.id!)
      Deferred.doneUnsafe(
        deferred,
        message.error
          ? Effect.fail(codexError(message.error.message ?? JSON.stringify(message.error)))
          : Effect.succeed(message.result),
      )
    })

    const request = <A>(
      method: string,
      params: unknown,
      timeout: Duration.Duration = REQUEST_TIMEOUT,
    ): Effect.Effect<A, AgentError> =>
      Effect.suspend(() => {
        if (exitError !== undefined) return Effect.fail(exitError)
        const id = nextId++
        const deferred = Deferred.makeUnsafe<unknown, AgentError>()
        pending.set(id, deferred)
        write({ method, id, params })
        return Deferred.await(deferred).pipe(
          Effect.onInterrupt(() => Effect.sync(() => pending.delete(id))),
          Effect.timeoutOrElse({
            duration: timeout,
            orElse: () =>
              Effect.fail(codexError(`codex app-server did not respond within ${Duration.format(timeout)}.`)),
          }),
          Effect.mapError((error) => codexError(`${method}: ${error.message}`)),
        ) as Effect.Effect<A, AgentError>
      })

    const client: CodexClient = {
      isAlive: () => exitError === undefined,
      request,
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

    const initializeParams: InitializeParams = {
      clientInfo: { name: "kkcode", title: "kkcode", version: options.clientVersion },
      capabilities: { experimentalApi: true },
    }
    yield* request("initialize", initializeParams, INITIALIZE_TIMEOUT).pipe(
      Effect.mapError((error) =>
        codexError(
          `${error.message} Run \`${options.binaryPath} app-server\` in a terminal to see why it does not start.`,
        ),
      ),
    )
    write({ method: "initialized" })

    return client
  })
