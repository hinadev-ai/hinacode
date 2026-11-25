import type { NonEmptyReadonlyArray } from "effect/Array"
import { createServer, type RequestListener, type Server } from "node:http"
import { Clock, Duration, Effect, Fiber, Option, Schedule, Schema, type Scope } from "effect"
import { WebSocket, WebSocketServer } from "ws"
import { compactPushes } from "../../shared/compactTranscript.ts"
import {
  desktopOnlyMethods,
  desktopOnlyPushes,
  machineOnlyMethods,
  mutations,
  type PushEvent,
  type RpcEnvelope,
  type RpcMethod,
} from "../../shared/contract.ts"
import {
  ClientFrame,
  CLOSE_LISTENER_STOPPED,
  CLOSE_MALFORMED_FRAME,
  isAddressNotUpYet,
  REMOTE_PATH,
  REMOTE_PROTOCOL_VERSION,
  reachesPhone,
  type RemoteFeature,
  type ServerFrame,
} from "../../shared/remote.ts"
import type { EnvironmentIdentity } from "./access.ts"

const HEARTBEAT_INTERVAL = Duration.seconds(20)
const ADDRESS_RETRY = Schedule.min([Schedule.exponential("500 millis"), Schedule.spaced("30 seconds")])
const CALL_KEY_TTL_MS = Duration.toMillis(Duration.minutes(5))
export const MAX_CALL_KEYS = 2000

const decodeClientFrame = Schema.decodeUnknownOption(ClientFrame)

export const parseClientFrame = (text: string): ClientFrame | undefined => {
  try {
    return Option.getOrUndefined(decodeClientFrame(JSON.parse(text)))
  } catch {
    return undefined
  }
}

export const readFrame = (socket: WebSocket, raw: unknown, isBinary: boolean): ClientFrame | undefined => {
  // FIXME: ws still emits frames that arrive during the close handshake
  if (socket.readyState !== WebSocket.OPEN) return undefined
  const frame = isBinary ? undefined : parseClientFrame(String(raw))
  if (frame === undefined) socket.close(CLOSE_MALFORMED_FRAME, "malformed frame")
  return frame
}

export interface SessionChannel {
  readonly send: (frame: typeof ServerFrame.Encoded) => void
  readonly close: (code: number, reason: string) => void
  readonly ping: () => void
  readonly terminate: () => void
  readonly onPong: (listener: () => void) => void
  readonly onClose: (listener: () => void) => void
}

export const socketChannel = (
  socket: WebSocket,
  seal: (json: string) => string | Uint8Array = (json) => json,
): SessionChannel => ({
  send: (frame) => {
    if (socket.readyState === WebSocket.OPEN) socket.send(seal(JSON.stringify(frame)))
  },
  close: (code, reason) => socket.close(code, reason),
  ping: () => socket.ping(),
  terminate: () => socket.terminate(),
  onPong: (listener) => void socket.on("pong", listener),
  onClose: (listener) => void socket.on("close", listener),
})

const desktopOnly = (method: string): RpcEnvelope<never> => ({
  error: { tag: "DesktopOnly", message: `${method} is only available in the desktop window` },
})

const machineOnly = (method: string): RpcEnvelope<never> => ({
  error: { tag: "MachineOnly", message: `${method} is only available on the machine itself` },
})

const busy: RpcEnvelope<never> = {
  error: { tag: "RemoteBusy", message: "Too many actions are still running. Try again when one finishes." },
}

export const describeError = (error: unknown) => (error instanceof Error ? error.message : String(error))

interface KeyedCall {
  readonly result: Promise<RpcEnvelope<unknown>>
  readonly settledAt: number | null
}

interface Peer {
  awaitingPong: boolean
  watching: ReadonlySet<string> | null
}

type SessionFrame = Extract<ClientFrame, { type: "call" | "ping" | "watch" }>

interface SessionOptions<R> {
  readonly call: (raw: { method: string; payload: unknown }) => Effect.Effect<RpcEnvelope<unknown>, never, R>
  readonly subscribe: (sink: (event: typeof PushEvent.Encoded) => void) => Effect.Effect<void, never, Scope.Scope>
  readonly environment: EnvironmentIdentity
  readonly features: ReadonlyArray<RemoteFeature>
  readonly remote: boolean
}

export const makeSessions = <R>({ call, subscribe, environment, features, remote }: SessionOptions<R>) =>
  Effect.gen(function* () {
    const services = yield* Effect.context<R>()
    const runFork = Effect.runForkWith(services)
    const runPromise = Effect.runPromiseWith(services)
    const now = () => Effect.runSyncWith(services)(Clock.currentTimeMillis)

    const peers = new Map<SessionChannel, Peer>()

    const attach = (
      channel: SessionChannel,
      {
        compactEvents,
        relay,
        hosts,
      }: { compactEvents: boolean; relay?: string; hosts?: NonEmptyReadonlyArray<string> },
    ) => {
      const peer: Peer = { awaitingPong: false, watching: null }
      peers.set(channel, peer)
      channel.onPong(() => {
        peer.awaitingPong = false
      })
      const compactPush = compactPushes()
      const subscription = runFork(
        Effect.scoped(
          subscribe((event) => {
            if (desktopOnlyPushes.has(event.type) || !reachesPhone(event, peer.watching)) return
            const outgoing = compactEvents ? compactPush(event) : event
            if (outgoing !== null) channel.send({ type: "event", event: outgoing })
          }).pipe(Effect.andThen(Effect.never)),
        ),
      )
      channel.onClose(() => {
        peers.delete(channel)
        runFork(Fiber.interrupt(subscription))
      })
      channel.send({
        type: "ready",
        version: REMOTE_PROTOCOL_VERSION,
        environment,
        features,
        ...(hosts !== undefined && { hosts }),
        ...(relay !== undefined && { relay }),
      })
    }

    const run = (method: string, payload: unknown): Promise<RpcEnvelope<unknown>> =>
      desktopOnlyMethods.has(method as RpcMethod)
        ? Promise.resolve(desktopOnly(method))
        : remote && machineOnlyMethods.has(method as RpcMethod)
          ? Promise.resolve(machineOnly(method))
          : runPromise(call({ method, payload })).catch((error: unknown) => ({
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

    const receive = (channel: SessionChannel, frame: SessionFrame) => {
      if (frame.type === "ping") return channel.send({ type: "pong", at: frame.at })
      if (frame.type === "watch") {
        const peer = peers.get(channel)
        if (peer !== undefined) peer.watching = new Set(frame.threadIds)
        return
      }
      const { id, method, payload, key } = frame
      const result = key !== undefined && mutations.has(method) ? runOnce(key, method, payload) : run(method, payload)
      void result.then((envelope) => channel.send({ type: "result", id, envelope }))
    }

    const heartbeat = Effect.sync(() => {
      for (const [channel, peer] of peers) {
        if (peer.awaitingPong) {
          channel.terminate()
          continue
        }
        peer.awaitingPong = true
        channel.ping()
      }
    })
    yield* heartbeat.pipe(Effect.repeat(Schedule.spaced(HEARTBEAT_INTERVAL)), Effect.forkScoped)

    return {
      attach,
      receive,
      count: () => peers.size,
    }
  })

const answerNotFound: RequestListener = (_, response) => response.writeHead(404).end()

export const listenWebSockets = ({
  listen,
  accept,
  maxPayload,
  request = answerNotFound,
}: {
  readonly listen: (server: Server, listening: () => void) => void
  readonly accept: (socket: WebSocket) => void
  readonly maxPayload: number
  readonly request?: RequestListener
}) =>
  Effect.acquireRelease(
    Effect.callback<{ server: Server; wss: WebSocketServer }, Error>((resume) => {
      const server = createServer(request)
      const wss = new WebSocketServer({
        server,
        path: REMOTE_PATH,
        maxPayload,
        perMessageDeflate: false,
      })
      wss.on("connection", accept)
      // FIXME: ws re-emits the http server's errors on wss, and an unhandled emit throws
      wss.on("error", (error) => resume(Effect.fail(error)))
      listen(server, () => resume(Effect.succeed({ server, wss })))
    }),
    // FIXME: wss.close() leaves an external http server listening
    // FIXME: closeAllConnections() skips upgraded sockets
    ({ server, wss }) =>
      Effect.sync(() => {
        for (const socket of wss.clients) socket.close(CLOSE_LISTENER_STOPPED, "listener stopped")
        server.closeAllConnections()
        server.close()
      }),
  )

export const retryUntilAddressIsUp = <A, R>(listen: Effect.Effect<A, Error, R>) =>
  listen.pipe(Effect.retry({ while: (error) => isAddressNotUpYet(error.message), schedule: ADDRESS_RETRY }))
