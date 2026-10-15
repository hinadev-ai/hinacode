import { Effect, Schema } from "effect"
import { create } from "zustand"
import {
  mutations,
  type PushEvent,
  type RpcMethod,
  RpcMethods,
  type RpcRequest,
  type RpcResponse,
} from "@shared/contract.ts"
import { type PairingTarget, remoteWebSocketUrl } from "@shared/remote.ts"
import { RpcError, Transport, type TransportStatus } from "./transport"

export { RpcError } from "./transport"

export type ConnectionStatus = TransportStatus

interface ConnectionState {
  readonly target: PairingTarget | null
  readonly status: ConnectionStatus
  /** Why the desktop refused us, shown on the connect screen. */
  readonly error: string | null
  /** Counts successful handshakes. Snapshots are reloaded after each one, since pushes sent meanwhile are lost. */
  readonly generation: number
  /** What the desktop of the latest handshake understands, e.g. `terminal-attach`. */
  readonly features: ReadonlySet<string>
}

export const useConnection = create<ConnectionState>()(() => ({
  target: null,
  status: "offline",
  error: null,
  generation: 0,
  features: new Set(),
}))

let transport: Transport | null = null
const listeners = new Set<(event: PushEvent) => void>()

/** Opens the single socket to `target`, replacing any previous one. */
export function connect(target: PairingTarget) {
  transport?.stop()
  useConnection.setState({ target, error: null })
  const current = new Transport({
    url: remoteWebSocketUrl(target),
    token: target.token,
    isMutation: (method) => mutations.has(method),
    onStatus: (status, error) => {
      if (transport === current) useConnection.setState({ status, error })
    },
    onReady: (features) => {
      if (transport === current) useConnection.setState((state) => ({ features, generation: state.generation + 1 }))
    },
    onEvent: (event) => {
      for (const listener of listeners) listener(event)
    },
  })
  transport = current
  current.start()
}

export function disconnect() {
  transport?.stop()
  transport = null
  useConnection.setState({ target: null, status: "offline", error: null })
}

/** Skips the remaining backoff. */
export const reconnectNow = () => transport?.reconnectNow()

/** The device switched networks, so the current socket is probably dead even if it looks open. */
export const networkChanged = () => transport?.networkChanged()

export const setForeground = (foreground: boolean) => transport?.setForeground(foreground)

export function onEvent(listener: (event: PushEvent) => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * Calls the desktop. While the link is down the call waits and is sent after the next handshake, so it
 * runs once. Rejects with `RpcError` carrying the handler's error tag, or `Timeout` after a minute offline.
 */
export function call<M extends RpcMethod>(method: M, payload: RpcRequest<M>): Promise<RpcResponse<M>> {
  const spec = RpcMethods[method]
  const encodeRequest = Schema.encodeEffect(spec.request)
  const decodeResponse = Schema.decodeUnknownEffect(spec.response)
  return Effect.runPromise(
    Effect.gen(function* () {
      const encoded = yield* encodeRequest(payload)
      const envelope = yield* Effect.tryPromise({
        try: () =>
          transport === null
            ? Promise.reject(new RpcError("Offline", "Not connected to the desktop."))
            : transport.call(method, encoded),
        catch: (cause) => (cause instanceof RpcError ? cause : new RpcError("Offline", String(cause))),
      })
      if ("error" in envelope) return yield* Effect.fail(new RpcError(envelope.error.tag, envelope.error.message))
      return yield* decodeResponse(envelope.result)
    }).pipe(
      Effect.catchTag("SchemaError", (error) => Effect.fail(new RpcError(error._tag, error.message))),
    ) as Effect.Effect<RpcResponse<M>, RpcError>,
  )
}
