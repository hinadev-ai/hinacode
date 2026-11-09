import { randomUUID } from "node:crypto"
import { type Cause, Data, Duration, Effect, Queue, Schema, Scope } from "effect"
import { errorReported } from "effect/Runtime"
import { WebSocket } from "ws"
import {
  methodKind,
  type PushEvent,
  type RpcMethod,
  RpcMethods,
  type RpcRequest,
  type RpcResponse,
} from "../shared/contract.ts"
import { type ClientFrame, REMOTE_MAX_FRAME_BYTES, REMOTE_PATH, ServerFrame } from "../shared/remote.ts"
import { CliFailure, EXIT, unreachableError, usageError } from "./exit.ts"

const READY_TIMEOUT = Duration.seconds(2)

export type Ready = Extract<ServerFrame, { type: "ready" }>

type Envelope = Extract<ServerFrame, { type: "result" }>["envelope"]

export class RpcError extends Data.TaggedError("RpcError")<{ readonly tag: string; readonly message: string }> {
  override readonly [errorReported] = false
}

export class NoSocket extends Data.TaggedError("NoSocket")<{ readonly socketPath: string }> {}

export interface Client {
  readonly socketPath: string
  readonly ready: Ready
  readonly call: <M extends RpcMethod>(
    method: M,
    payload: RpcRequest<M>,
  ) => Effect.Effect<RpcResponse<M>, RpcError | CliFailure>
  readonly subscribe: Effect.Effect<Queue.Dequeue<PushEvent, Cause.Done>, never, Scope.Scope>
  readonly watch: (threadIds: ReadonlyArray<string>) => Effect.Effect<void>
}

const decodeServerFrame = Schema.decodeUnknownExit(Schema.fromJsonString(ServerFrame))

const forwardTo = (queue: Queue.Queue<PushEvent, Cause.Done>) => (event: PushEvent | null) =>
  event === null ? Queue.endUnsafe(queue) : Queue.offerUnsafe(queue, event)

const disconnected = () => unreachableError("lost the connection to HinaCode")

const open = (socketPath: string) =>
  Effect.callback<{ socket: WebSocket; first: ServerFrame }, NoSocket | CliFailure>((resume) => {
    const socket = new WebSocket(`ws+unix://${socketPath}:${REMOTE_PATH}`, { maxPayload: REMOTE_MAX_FRAME_BYTES })
    socket.once("error", () => resume(Effect.fail(new NoSocket({ socketPath }))))
    socket.once("close", () => resume(Effect.fail(new NoSocket({ socketPath }))))
    socket.once("message", (raw) => {
      const decoded = decodeServerFrame(String(raw))
      resume(
        decoded._tag === "Success"
          ? Effect.succeed({ socket, first: decoded.value })
          : Effect.fail(
              new CliFailure({ code: EXIT.unreachable, message: `${socketPath} sent a frame the CLI can't read` }),
            ),
      )
    })
    return Effect.sync(() => socket.terminate())
  })

const handshake = (socketPath: string) =>
  Effect.gen(function* () {
    const { socket, first } = yield* open(socketPath).pipe(
      Effect.timeoutOrElse({ duration: READY_TIMEOUT, orElse: () => Effect.fail(new NoSocket({ socketPath })) }),
    )
    if (first.type === "challenge") {
      socket.terminate()
      return yield* unreachableError(`${socketPath} asks for a token, so it is a remote listener, not the CLI socket`)
    }
    if (first.type !== "ready") {
      socket.terminate()
      return yield* unreachableError(`${socketPath} sent ${first.type} before ready`)
    }
    return { socket, ready: first }
  })

export const connect = (socketPath: string): Effect.Effect<Client, NoSocket | CliFailure, Scope.Scope> =>
  Effect.gen(function* () {
    const { socket, ready } = yield* Effect.acquireRelease(handshake(socketPath), (opened) =>
      Effect.sync(() => opened.socket.close()),
    )
    const pending = new Map<number, (envelope: Envelope | null) => void>()
    const listeners = new Set<(event: PushEvent | null) => void>()
    let nextId = 1
    let closed = false

    socket.on("message", (raw) => {
      const decoded = decodeServerFrame(String(raw))
      if (decoded._tag === "Failure") return
      const frame = decoded.value
      if (frame.type === "result") {
        pending.get(frame.id)?.(frame.envelope)
        pending.delete(frame.id)
      } else if (frame.type === "event") {
        for (const listener of listeners) listener(frame.event)
      }
    })
    socket.on("close", () => {
      closed = true
      for (const settle of pending.values()) settle(null)
      pending.clear()
      for (const listener of listeners) listener(null)
    })

    const send = (frame: ClientFrame) => socket.send(JSON.stringify(frame))

    const exchange = (method: RpcMethod, payload: unknown) =>
      Effect.callback<Envelope, CliFailure>((resume) => {
        if (closed) return resume(Effect.fail(disconnected()))
        const id = nextId++
        pending.set(id, (envelope) =>
          resume(envelope === null ? Effect.fail(disconnected()) : Effect.succeed(envelope)),
        )
        send({
          type: "call",
          id,
          method,
          ...(payload !== undefined && { payload }),
          ...(methodKind[method] === "mutation" && { key: randomUUID() }),
        })
        return Effect.sync(() => pending.delete(id))
      })

    const call = <M extends RpcMethod>(method: M, payload: RpcRequest<M>) =>
      Effect.gen(function* () {
        const spec = RpcMethods[method]
        const encoded = yield* Schema.encodeUnknownEffect(spec.request)(payload).pipe(
          Effect.mapError((error) => usageError(`${method}: ${error.message}`)),
        )
        const envelope = yield* exchange(method, encoded)
        if ("error" in envelope) return yield* new RpcError(envelope.error)
        return yield* Schema.decodeUnknownEffect(spec.response)(envelope.result).pipe(
          Effect.mapError(
            (error) =>
              new CliFailure({
                code: EXIT.failed,
                message: `${method} answered in an unexpected shape: ${error.message}`,
              }),
          ),
        )
      })

    const subscribe = Effect.acquireRelease(
      Effect.gen(function* () {
        const queue = yield* Queue.unbounded<PushEvent, Cause.Done>()
        const listener = forwardTo(queue)
        listeners.add(listener)
        if (closed) Queue.endUnsafe(queue)
        return { queue, listener }
      }),
      ({ listener }) => Effect.sync(() => listeners.delete(listener)),
    ).pipe(Effect.map(({ queue }): Queue.Dequeue<PushEvent, Cause.Done> => queue))

    const watch = (threadIds: ReadonlyArray<string>) => Effect.sync(() => send({ type: "watch", threadIds }))

    return { socketPath, ready, call, subscribe, watch }
  })
