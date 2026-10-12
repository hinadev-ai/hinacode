import { createServer, type Server } from "node:http"
import { Cause, Effect, Fiber, FiberHandle, Layer, Option, Schema, Stream } from "effect"
import { WebSocket, WebSocketServer } from "ws"
import { desktopOnlyMethods, type RpcEnvelope } from "../../shared/contract.ts"
import type { Settings as SettingsValue } from "../../shared/domain.ts"
import { ClientFrame, REMOTE_PATH, REMOTE_PROTOCOL_VERSION, type ServerFrame } from "../../shared/remote.ts"
import { type AppServices, dispatch } from "../ipc.ts"
import { PushBroadcast } from "../services/Events.ts"
import { Settings } from "../services/Settings.ts"
import { RemoteAccess } from "./access.ts"

/** A socket that has not sent a valid `auth` frame by then is closed. */
const AUTH_TIMEOUT_MS = 5000

/** Close codes the phone can tell apart from a network drop. */
export const CLOSE_UNAUTHORIZED = 4001
export const CLOSE_TOKEN_ROTATED = 4002
export const CLOSE_LISTENER_STOPPED = 4003

const decodeClientFrame = Schema.decodeUnknownOption(ClientFrame)

const parseFrame = (raw: unknown): ClientFrame | undefined => {
  try {
    return Option.getOrUndefined(decodeClientFrame(JSON.parse(String(raw))))
  } catch {
    return undefined
  }
}

const desktopOnly = (method: string): RpcEnvelope<never> => ({
  error: { tag: "DesktopOnly", message: `${method} is only available in the desktop window` },
})

const send = (socket: WebSocket, frame: ServerFrame) => {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame))
}

const describeCause = (cause: Cause.Cause<unknown>) => {
  const error = Cause.squash(cause)
  return error instanceof Error ? error.message : String(error)
}

/**
 * The remote mode listener: a WebSocket on `settings.remote` that speaks `ClientFrame` and `ServerFrame`,
 * dispatching calls through the same path as the Electron `rpc` channel and forwarding every push.
 */
const make = Effect.gen(function* () {
  const access = yield* RemoteAccess
  const broadcast = yield* PushBroadcast
  const settings = yield* Settings
  const services = yield* Effect.context<AppServices | PushBroadcast>()
  const runFork = Effect.runForkWith(services)
  const runPromise = Effect.runPromiseWith(services)

  const sockets = new Set<WebSocket>()
  const countConnected = () => runFork(access.report({ connected: sockets.size }))

  const attach = (socket: WebSocket) => {
    sockets.add(socket)
    countConnected()
    const subscription = runFork(
      Effect.scoped(
        broadcast.subscribe((event) => send(socket, { type: "event", event })).pipe(Effect.andThen(Effect.never)),
      ),
    )
    socket.on("close", () => {
      sockets.delete(socket)
      countConnected()
      runFork(Fiber.interrupt(subscription))
    })
    send(socket, { type: "ready", version: REMOTE_PROTOCOL_VERSION })
  }

  const handleCall = (socket: WebSocket, id: number, method: string, payload: unknown) => {
    const answer = (envelope: RpcEnvelope<unknown>) => send(socket, { type: "result", id, envelope })
    if (desktopOnlyMethods.has(method as never)) return answer(desktopOnly(method))
    void runPromise(dispatch({ method, payload }, null)).then(answer)
  }

  const accept = (socket: WebSocket) => {
    let authenticated = false
    const deadline = setTimeout(() => {
      if (!authenticated) socket.close(CLOSE_UNAUTHORIZED, "auth timeout")
    }, AUTH_TIMEOUT_MS)
    socket.on("close", () => clearTimeout(deadline))
    socket.on("error", () => {})
    socket.on("message", (raw, isBinary) => {
      const frame = isBinary ? undefined : parseFrame(raw)
      if (frame === undefined) return socket.close(CLOSE_UNAUTHORIZED, "malformed frame")
      if (!authenticated) {
        if (frame.type !== "auth" || !access.authenticate(frame.token)) {
          return socket.close(CLOSE_UNAUTHORIZED, "unauthorized")
        }
        authenticated = true
        clearTimeout(deadline)
        return attach(socket)
      }
      if (frame.type === "call") handleCall(socket, frame.id, frame.method, frame.payload)
    })
  }

  const closeAll = (code: number, reason: string) => {
    for (const socket of sockets) socket.close(code, reason)
  }

  const listen = (address: SettingsValue["remote"]) =>
    Effect.acquireRelease(
      Effect.callback<Server, Error>((resume) => {
        const server = createServer((_, response) => response.writeHead(404).end())
        const wss = new WebSocketServer({ server, path: REMOTE_PATH, maxPayload: 1024 * 1024 })
        wss.on("connection", accept)
        server.once("error", (error) => resume(Effect.fail(error)))
        server.listen(address.port, address.bindHost, () => resume(Effect.succeed(server)))
      }),
      // ws leaves an external http server running, so the port is released here, not by wss.close().
      (server) =>
        Effect.sync(() => {
          closeAll(CLOSE_LISTENER_STOPPED, "listener stopped")
          server.closeAllConnections()
          server.close()
        }),
    ).pipe(
      Effect.andThen(access.report({ listening: true, listenError: null })),
      Effect.andThen(Effect.logInfo("remote listening", `${address.bindHost}:${address.port}`)),
      Effect.andThen(Effect.never),
      Effect.scoped,
      Effect.ensuring(access.report({ listening: false })),
    )

  const listener = yield* FiberHandle.make()
  const apply = (remote: SettingsValue["remote"]) =>
    Effect.gen(function* () {
      yield* FiberHandle.clear(listener)
      yield* access.report({ listenError: null })
      if (!remote.enabled) return
      yield* FiberHandle.run(
        listener,
        listen(remote).pipe(
          Effect.catchCause((cause) =>
            access
              .report({ listenError: describeCause(cause) })
              .pipe(Effect.andThen(Effect.logWarning("remote listener failed", cause))),
          ),
        ),
      )
    })

  let current = (yield* settings.get).remote
  yield* apply(current)
  yield* (yield* settings.changes).pipe(
    Stream.runForEach(({ remote }) => {
      const same =
        remote.enabled === current.enabled && remote.bindHost === current.bindHost && remote.port === current.port
      if (same) return Effect.void
      current = remote
      return apply(remote)
    }),
    Effect.forkScoped,
  )
  yield* access.rotations.pipe(
    Stream.runForEach(() => Effect.sync(() => closeAll(CLOSE_TOKEN_ROTATED, "token rotated"))),
    Effect.forkScoped,
  )
})

export const layer = Layer.effectDiscard(make)
