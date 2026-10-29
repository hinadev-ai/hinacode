import { MspError, spawnMspConnection } from "@muse-code/sdk"
import { Duration, Effect, Schema, Scope } from "effect"
import { AgentError } from "../provider.ts"

export type Incoming =
  | { readonly kind: "notification"; readonly method: string; readonly params: unknown }
  | { readonly kind: "request"; readonly method: string; readonly params: unknown }
  | { readonly kind: "exit"; readonly error: AgentError }

export class MuseCallError extends Schema.TaggedError<MuseCallError>()("MuseCallError", {
  method: Schema.String,
  kind: Schema.String,
  message: Schema.String,
}) {}

export const toAgentError = (error: MuseCallError) =>
  new AgentError({ provider: "muse", message: `${error.method}: ${error.message}` })

export interface MuseHost {
  readonly isAlive: () => boolean
  readonly request: <A>(method: string, params: object) => Effect.Effect<A, MuseCallError>
  readonly command: <A>(method: string, params: object) => Effect.Effect<A, MuseCallError>
  readonly subscribe: (listener: (message: Incoming) => void) => Effect.Effect<void, never, Scope.Scope>
}

export const REQUEST_TIMEOUT = Duration.seconds(60)

const messageOf = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause))

// FIXME: MSP server requests only ask the client to confirm it showed them, so they get an empty answer
export const makeMuseHost = (options: {
  readonly binaryPath: string
  readonly args: ReadonlyArray<string>
  readonly env: NodeJS.ProcessEnv
  readonly clientVersion: string
}) =>
  Effect.gen(function* () {
    const listeners = new Set<(message: Incoming) => void>()
    let exitError: AgentError | undefined
    let stderrTail = ""
    const emit = (message: Incoming) => {
      for (const listener of listeners) listener(message)
    }
    const handleExit = (error: AgentError) => {
      if (exitError !== undefined) return
      exitError = error
      emit({ kind: "exit", error })
    }

    const handshake = spawnMspConnection({
      command: options.binaryPath,
      args: options.args,
      env: options.env,
      onStderr: (chunk) => {
        stderrTail = (stderrTail + chunk).slice(-2000)
      },
    })
    handshake.onNotification(({ method, params }) => emit({ kind: "notification", method, params }))
    handshake.onServerRequest(async ({ method, params }) => {
      emit({ kind: "request", method, params })
      return {}
    })

    const spawned = yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: () =>
          handshake.initialize({
            clientInfo: { name: "hinacode", version: options.clientVersion },
            // FIXME: MSP gates `account/read` behind experimentalApi
            capabilities: { experimentalApi: true, requestedCapabilities: ["sessionMcp"] },
          }),
        catch: (cause) =>
          new AgentError({
            provider: "muse",
            message: `muse serve did not start: ${messageOf(cause)} ${stderrTail.trim()} Run \`${options.binaryPath} serve\` in a terminal to see why.`,
          }),
      }).pipe(Effect.onError(() => Effect.promise(() => handshake.close()).pipe(Effect.ignore))),
      (connection) => Effect.promise(() => connection.close()).pipe(Effect.ignore),
    )
    void spawned.exited.then(({ code, signal }) =>
      handleExit(
        new AgentError({
          provider: "muse",
          message: `muse serve exited (code ${code}, signal ${signal}). ${stderrTail.trim()}`,
        }),
      ),
    )

    const call = <A>(method: string, run: () => Promise<Record<string, unknown>>): Effect.Effect<A, MuseCallError> =>
      Effect.suspend(() => {
        if (exitError !== undefined) {
          return Effect.fail(new MuseCallError({ method, kind: "exited", message: exitError.message }))
        }
        return Effect.tryPromise({
          try: run,
          catch: (cause) =>
            new MuseCallError({
              method,
              kind: cause instanceof MspError ? cause.kind : "protocol",
              message: messageOf(cause),
            }),
        }).pipe(
          Effect.timeoutOrElse({
            duration: REQUEST_TIMEOUT,
            orElse: () =>
              Effect.fail(
                new MuseCallError({
                  method,
                  kind: "timeout",
                  message: `muse serve did not answer within ${Duration.format(REQUEST_TIMEOUT)}`,
                }),
              ),
          }),
        ) as Effect.Effect<A, MuseCallError>
      })

    const host: MuseHost = {
      isAlive: () => exitError === undefined,
      request: (method, params) => call(method, () => spawned.connection.request(method, { ...params })),
      command: (method, params) => call(method, () => spawned.connection.command(method, { ...params })),
      subscribe: (listener) =>
        Effect.acquireRelease(
          Effect.sync(() => {
            listeners.add(listener)
            if (exitError !== undefined) listener({ kind: "exit", error: exitError })
          }),
          () => Effect.sync(() => listeners.delete(listener)),
        ),
    }
    return host
  })
