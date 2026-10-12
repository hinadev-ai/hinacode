import { Effect, Option, Schema } from "effect"
import { create } from "zustand"
import {
  type PushEvent,
  type RpcEnvelope,
  type RpcMethod,
  RpcMethods,
  type RpcRequest,
  type RpcRequestEncoded,
  type RpcResponse,
} from "@shared/contract.ts"
import {
  type ClientFrame,
  type PairingTarget,
  REMOTE_PROTOCOL_VERSION,
  remoteWebSocketUrl,
  ServerFrame,
} from "@shared/remote.ts"

export type ConnectionStatus = "connecting" | "connected" | "unauthorized" | "offline"

interface ConnectionState {
  readonly target: PairingTarget | null
  readonly status: ConnectionStatus
  /** Why the desktop refused us, shown on the connect screen. */
  readonly error: string | null
}

export const useConnection = create<ConnectionState>()(() => ({ target: null, status: "offline", error: null }))

export class RpcError extends Error {
  constructor(
    readonly tag: string,
    message: string,
  ) {
    super(message)
  }
}

const CLOSE_UNAUTHORIZED = 4001
const CLOSE_TOKEN_ROTATED = 4002
const MIN_RETRY_MS = 1_000
const MAX_RETRY_MS = 30_000

let socket: WebSocket | null = null
let retryTimer: ReturnType<typeof setTimeout> | undefined
let attempt = 0
let nextCallId = 1
const pending = new Map<number, { resolve: (envelope: RpcEnvelope<unknown>) => void; reject: (error: Error) => void }>()
const listeners = new Set<(event: PushEvent) => void>()
const decodeFrame = Schema.decodeUnknownOption(ServerFrame)

/** Opens the single socket to `target`, replacing any previous one. */
export function connect(target: PairingTarget) {
  closeSocket()
  attempt = 0
  useConnection.setState({ target, error: null })
  open()
}

export function disconnect() {
  closeSocket()
  useConnection.setState({ target: null, status: "offline", error: null })
}

/** Skips the remaining backoff, e.g. when the app returns to the foreground. */
export function reconnectNow() {
  if (useConnection.getState().status !== "offline" || retryTimer === undefined) return
  clearTimeout(retryTimer)
  retryTimer = undefined
  open()
}

export function onEvent(listener: (event: PushEvent) => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Calls the desktop. Rejects with `RpcError` carrying the handler's error tag and message. */
export function call<M extends RpcMethod>(method: M, payload: RpcRequest<M>): Promise<RpcResponse<M>> {
  const spec = RpcMethods[method]
  const encodeRequest = Schema.encodeEffect(spec.request)
  const decodeResponse = Schema.decodeUnknownEffect(spec.response)
  return Effect.runPromise(
    Effect.gen(function* () {
      const encoded = yield* encodeRequest(payload)
      const envelope = yield* Effect.tryPromise({
        try: () => send(method, encoded),
        catch: (cause) => (cause instanceof RpcError ? cause : new RpcError("Offline", String(cause))),
      })
      if ("error" in envelope) return yield* Effect.fail(new RpcError(envelope.error.tag, envelope.error.message))
      return yield* decodeResponse(envelope.result)
    }).pipe(
      Effect.catchTag("SchemaError", (error) => Effect.fail(new RpcError(error._tag, error.message))),
    ) as Effect.Effect<RpcResponse<M>, RpcError>,
  )
}

function send<M extends RpcMethod>(method: M, payload: RpcRequestEncoded<M>) {
  return new Promise<RpcEnvelope<unknown>>((resolve, reject) => {
    if (socket === null || useConnection.getState().status !== "connected") {
      reject(new RpcError("Offline", "Not connected to the desktop."))
      return
    }
    const id = nextCallId++
    // JSON has no undefined, so methods without a payload omit the key.
    const frame: ClientFrame =
      payload === undefined ? { type: "call", id, method } : { type: "call", id, method, payload }
    pending.set(id, { resolve, reject })
    socket.send(JSON.stringify(frame))
  })
}

function open() {
  const { target } = useConnection.getState()
  if (target === null) return
  useConnection.setState({ status: "connecting" })
  const ws = new WebSocket(remoteWebSocketUrl(target))
  socket = ws
  ws.onopen = () => {
    const auth: ClientFrame = { type: "auth", token: target.token }
    ws.send(JSON.stringify(auth))
  }
  ws.onmessage = (message) => {
    if (socket === ws) receive(ws, message.data)
  }
  ws.onclose = (event) => {
    if (socket !== ws) return
    socket = null
    rejectPending()
    if (event.code === CLOSE_UNAUTHORIZED || event.code === CLOSE_TOKEN_ROTATED) {
      useConnection.setState({
        status: "unauthorized",
        error:
          event.code === CLOSE_TOKEN_ROTATED
            ? "The token was rotated on the desktop. Pair again with the new QR code."
            : "The desktop refused this token. Pair again from Settings > Remote.",
      })
      return
    }
    scheduleRetry()
  }
}

function receive(ws: WebSocket, data: unknown) {
  if (typeof data !== "string") return
  let json: unknown
  try {
    json = JSON.parse(data)
  } catch {
    return
  }
  // A push this app does not know yet (newer desktop) fails to decode and is skipped.
  const frame = Option.getOrNull(decodeFrame(json))
  if (frame === null) return
  switch (frame.type) {
    case "ready":
      if (frame.version !== REMOTE_PROTOCOL_VERSION) {
        socket = null
        ws.close()
        useConnection.setState({
          status: "unauthorized",
          error: `The desktop speaks remote protocol ${frame.version}, this app speaks ${REMOTE_PROTOCOL_VERSION}. Update the older one.`,
        })
        return
      }
      attempt = 0
      useConnection.setState({ status: "connected", error: null })
      return
    case "result": {
      const call = pending.get(frame.id)
      pending.delete(frame.id)
      call?.resolve("error" in frame.envelope ? frame.envelope : { result: frame.envelope.result })
      return
    }
    case "event":
      for (const listener of listeners) listener(frame.event)
  }
}

function scheduleRetry() {
  useConnection.setState({ status: "offline" })
  const delay = Math.min(MAX_RETRY_MS, MIN_RETRY_MS * 2 ** attempt)
  attempt++
  retryTimer = setTimeout(() => {
    retryTimer = undefined
    open()
  }, delay)
}

function closeSocket() {
  clearTimeout(retryTimer)
  retryTimer = undefined
  const ws = socket
  socket = null
  ws?.close()
  rejectPending()
}

function rejectPending() {
  for (const call of pending.values()) call.reject(new RpcError("Offline", "The connection to the desktop closed."))
  pending.clear()
}
