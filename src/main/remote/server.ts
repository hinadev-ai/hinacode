import { createServer, type Server } from "node:http"
import { Cause, Clock, Duration, Effect, Fiber, FiberHandle, Layer, Option, Schedule, Schema, Stream } from "effect"
import { WebSocket, WebSocketServer } from "ws"
import { compactPush } from "../../shared/compactTranscript.ts"
import {
  desktopOnlyMethods,
  desktopOnlyPushes,
  mutations,
  type RpcEnvelope,
  type RpcMethod,
} from "../../shared/contract.ts"
import { newNonce } from "../../shared/proof.ts"
import type { Settings as SettingsValue } from "../../shared/domain.ts"
import {
  ClientFrame,
  REMOTE_PATH,
  REMOTE_PROTOCOL_VERSION,
  reachesPhone,
  type RemoteFeature,
  type ServerFrame,
  SLOW_CONSUMER_BYTES,
} from "../../shared/remote.ts"
import { type AppServices, dispatch } from "../rpc.ts"
import { PushBroadcast } from "../services/Events.ts"
import { Settings } from "../services/Settings.ts"
import {
  CLOSE_AUTH_TIMEOUT,
  CLOSE_LISTENER_STOPPED,
  CLOSE_MALFORMED_FRAME,
  CLOSE_SLOW_CONSUMER,
  CLOSE_TOKEN_ROTATED,
  CLOSE_UNAUTHORIZED,
  RemoteAccess,
  relayHostname,
} from "./access.ts"
import { type Hub, Peers } from "./peers.ts"

/** A socket that has not sent a valid `auth` frame by then is closed. */
const AUTH_TIMEOUT = Duration.seconds(5)
const HEARTBEAT_INTERVAL = Duration.seconds(20)
const MAX_PAYLOAD_BYTES = 16 * 1024 * 1024
const CALL_KEY_TTL_MS = Duration.toMillis(Duration.minutes(5))
export const MAX_CALL_KEYS = 2000

const FEATURES: ReadonlyArray<RemoteFeature> = ["heartbeat", "call-keys", "terminal-attach", "asks", "watch"]

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

const send = (socket: WebSocket, frame: typeof ServerFrame.Encoded) => {
  if (socket.readyState !== WebSocket.OPEN) return
  if (socket.bufferedAmount > SLOW_CONSUMER_BYTES) return socket.close(CLOSE_SLOW_CONSUMER, "slow consumer")
  socket.send(JSON.stringify(frame))
}

const busy: RpcEnvelope<never> = {
  error: { tag: "RemoteBusy", message: "Too many actions are still running. Try again when one finishes." },
}

const describeError = (error: unknown) => (error instanceof Error ? error.message : String(error))

const describeCause = (cause: Cause.Cause<unknown>) => describeError(Cause.squash(cause))

interface KeyedCall {
  readonly result: Promise<RpcEnvelope<unknown>>
  readonly settledAt: number | null
}

interface PhonePeer {
  awaitingPong: boolean
  watching: ReadonlySet<string> | null
}

/**
 * The remote mode listener: a WebSocket on `settings.remote` that speaks `ClientFrame` and `ServerFrame`,
 * dispatching calls through the same path as the Electron `rpc` channel and forwarding every push.
 */
const make = Effect.gen(function* () {
  const access = yield* RemoteAccess
  const broadcast = yield* PushBroadcast
  const settings = yield* Settings
  const peers = yield* Peers
  const services = yield* Effect.context<AppServices | PushBroadcast>()
  const runFork = Effect.runForkWith(services)
  const runPromise = Effect.runPromiseWith(services)
  const now = () => Effect.runSyncWith(services)(Clock.currentTimeMillis)

  const sockets = new Map<WebSocket, PhonePeer>()
  const countConnected = () => runFork(access.report({ connected: sockets.size }))

  /** `proof` answers a client that proved its token; one that sent the token itself gets none. */
  const attach = (
    socket: WebSocket,
    { proof, compactEvents }: { readonly proof: string | undefined; readonly compactEvents: boolean },
  ) => {
    const peer: PhonePeer = { awaitingPong: false, watching: null }
    sockets.set(socket, peer)
    socket.on("pong", () => {
      peer.awaitingPong = false
    })
    countConnected()
    const subscription = runFork(
      Effect.scoped(
        broadcast
          .subscribe((event) => {
            if (desktopOnlyPushes.has(event.type) || !reachesPhone(event, peer.watching)) return
            send(socket, { type: "event", event: compactEvents ? compactPush(event) : event })
          })
          .pipe(Effect.andThen(Effect.never)),
      ),
    )
    socket.on("close", () => {
      sockets.delete(socket)
      countConnected()
      runFork(Fiber.interrupt(subscription))
    })
    const relay = relayHostname(Effect.runSyncWith(services)(access.status).relay)
    send(socket, {
      type: "ready",
      version: REMOTE_PROTOCOL_VERSION,
      environment: access.identity,
      features: FEATURES,
      ...(relay !== null && { relay }),
      ...(proof !== undefined && { proof }),
    })
  }

  const run = (method: string, payload: unknown): Promise<RpcEnvelope<unknown>> =>
    desktopOnlyMethods.has(method as RpcMethod)
      ? Promise.resolve(desktopOnly(method))
      : runPromise(dispatch({ method, payload }, null)).catch((error: unknown) => ({
          error: { tag: "Defect", message: describeError(error) },
        }))

  const keyed = new Map<string, KeyedCall>()

  const oldestSettled = () => {
    for (const [stored, entry] of keyed) if (entry.settledAt !== null) return stored
    return undefined
  }

  const markSettled = (key: string, result: Promise<RpcEnvelope<unknown>>) => {
    keyed.delete(key)
    keyed.set(key, { result, settledAt: now() })
  }

  const runOnce = (key: string, method: string, payload: unknown): Promise<RpcEnvelope<unknown>> => {
    const at = now()
    for (const [stored, entry] of keyed) {
      if (entry.settledAt === null) continue
      if (at - entry.settledAt < CALL_KEY_TTL_MS) break
      keyed.delete(stored)
    }
    const existing = keyed.get(key)
    if (existing !== undefined) return existing.result
    if (keyed.size >= MAX_CALL_KEYS) {
      const evicted = oldestSettled()
      if (evicted === undefined) return Promise.resolve(busy)
      keyed.delete(evicted)
    }
    const result = run(method, payload)
    keyed.set(key, { result, settledAt: null })
    void result.then(() => markSettled(key, result))
    return result
  }

  const handleCall = (socket: WebSocket, { id, method, payload, key }: Extract<ClientFrame, { type: "call" }>) => {
    const result = key !== undefined && mutations.has(method) ? runOnce(key, method, payload) : run(method, payload)
    void result.then((envelope) => send(socket, { type: "result", id, envelope }))
  }

  const accept = (socket: WebSocket) => {
    const challenge = newNonce()
    // The token's generation once the socket authenticated, so a rotation closes it without keeping what it sent.
    let generation: number | null = null
    let hub: Hub | null = null
    const deadline = runFork(
      Effect.sleep(AUTH_TIMEOUT).pipe(
        Effect.andThen(Effect.sync(() => socket.close(CLOSE_AUTH_TIMEOUT, "auth timeout"))),
      ),
    )
    socket.on("close", () => {
      runFork(Fiber.interrupt(deadline))
      hub?.leave()
    })
    socket.on("error", () => {})
    socket.on("message", (raw, isBinary) => {
      // Frames can still arrive while the close handshake runs; a closing socket must not authenticate or dispatch.
      if (socket.readyState !== WebSocket.OPEN) return
      const frame = isBinary ? undefined : parseFrame(raw)
      if (frame === undefined) return socket.close(CLOSE_MALFORMED_FRAME, "malformed frame")
      if (generation === null) {
        if (frame.type !== "auth") return socket.close(CLOSE_MALFORMED_FRAME, "expected auth")
        // Undefined for a client that sent the token itself, which predates the challenge and expects no proof.
        const proof =
          "proof" in frame
            ? access.answerChallenge(challenge, frame.nonce, frame.proof)
            : access.authenticate(frame.token)
              ? undefined
              : null
        if (proof === null) return socket.close(CLOSE_UNAUTHORIZED, "unauthorized")
        generation = access.generation()
        runFork(Fiber.interrupt(deadline))
        return attach(socket, { proof, compactEvents: frame.compactEvents ?? false })
      }
      if (access.generation() !== generation) return socket.close(CLOSE_TOKEN_ROTATED, "token rotated")
      if (frame.type === "ping") return send(socket, { type: "pong", at: frame.at })
      if (frame.type === "call") return handleCall(socket, frame)
      if (frame.type === "hub") hub ??= peers.join((ask) => send(socket, ask))
      const peer = sockets.get(socket)
      if (peer !== undefined && frame.type === "watch") peer.watching = new Set(frame.threadIds)
      if (frame.type === "answer") {
        const { envelope } = frame
        hub?.answer(frame.id, "error" in envelope ? envelope : { result: envelope.result })
      }
    })
    send(socket, { type: "challenge", nonce: challenge })
  }

  const closeAll = (code: number, reason: string) => {
    for (const socket of sockets.keys()) socket.close(code, reason)
  }

  const heartbeat = Effect.sync(() => {
    for (const [socket, peer] of sockets) {
      if (peer.awaitingPong) {
        socket.terminate()
        continue
      }
      peer.awaitingPong = true
      socket.ping()
    }
  })

  const listen = (address: Extract<SettingsValue["remote"], { enabled: true }>) =>
    Effect.acquireRelease(
      Effect.callback<{ server: Server; wss: WebSocketServer }, Error>((resume) => {
        const server = createServer((_, response) => response.writeHead(404).end())
        const wss = new WebSocketServer({
          server,
          path: REMOTE_PATH,
          maxPayload: MAX_PAYLOAD_BYTES,
          perMessageDeflate: true,
        })
        wss.on("connection", accept)
        // ws re-emits the http server's errors on wss, and an unhandled emit throws before any server listener runs.
        wss.on("error", (error) => resume(Effect.fail(error)))
        server.listen(address.port, address.bindHost, () => resume(Effect.succeed({ server, wss })))
      }),
      // ws leaves an external http server running, so the port is released here, not by wss.close().
      // wss.clients includes sockets that have not authenticated yet; closeAllConnections() skips upgraded ones.
      ({ server, wss }) =>
        Effect.sync(() => {
          for (const socket of wss.clients) socket.close(CLOSE_LISTENER_STOPPED, "listener stopped")
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
          Effect.catchCause((cause) => {
            const listenError = describeCause(cause)
            return access
              .report({ listenError })
              .pipe(Effect.andThen(Effect.logWarning("remote listener failed", listenError)))
          }),
        ),
      )
    })

  yield* heartbeat.pipe(Effect.repeat(Schedule.spaced(HEARTBEAT_INTERVAL)), Effect.forkScoped)

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
