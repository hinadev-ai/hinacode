import { Cause, Duration, Effect, Fiber, FiberHandle, Layer, Stream } from "effect"
import type { WebSocket } from "ws"
import { newNonce } from "../../shared/proof.ts"
import type { Settings as SettingsValue } from "../../shared/domain.ts"
import { dispatch } from "../rpc.ts"
import { PushBroadcast } from "../services/Events.ts"
import { Settings } from "../services/Settings.ts"
import {
  CLOSE_AUTH_TIMEOUT,
  CLOSE_MALFORMED_FRAME,
  CLOSE_TOKEN_ROTATED,
  CLOSE_UNAUTHORIZED,
  RemoteAccess,
  relayHostname,
} from "./access.ts"
import { type Hub, Peers } from "./peers.ts"
import { describeError, listenWebSockets, makeSessions, readFrame, send } from "./session.ts"

const AUTH_TIMEOUT = Duration.seconds(5)

const describeCause = (cause: Cause.Cause<unknown>) => describeError(Cause.squash(cause))

const make = Effect.gen(function* () {
  const access = yield* RemoteAccess
  const broadcast = yield* PushBroadcast
  const settings = yield* Settings
  const peers = yield* Peers
  const runFork = Effect.runForkWith(yield* Effect.context<never>())

  const sessions = yield* makeSessions({
    call: (raw) => dispatch(raw, null),
    subscribe: broadcast.subscribe,
    environment: access.identity,
    features: ["heartbeat", "call-keys", "terminal-attach", "asks", "watch"],
  })
  const countConnected = () => runFork(access.report({ connected: sessions.count() }))

  const attach = (
    socket: WebSocket,
    { proof, compactEvents }: { proof: string | undefined; compactEvents: boolean },
  ) => {
    const relay = relayHostname(Effect.runSync(access.status).relay) ?? undefined
    sessions.attach(socket, { compactEvents, relay, proof })
    countConnected()
    socket.on("close", countConnected)
  }

  const accept = (socket: WebSocket) => {
    const challenge = newNonce()
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
      const frame = readFrame(socket, raw, isBinary)
      if (frame === undefined) return
      if (generation === null) {
        if (frame.type !== "auth") return socket.close(CLOSE_MALFORMED_FRAME, "expected auth")
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
      if (frame.type === "auth") return
      if (frame.type === "hub") return void (hub ??= peers.join((ask) => send(socket, ask)))
      if (frame.type === "answer") {
        const { envelope } = frame
        return hub?.answer(frame.id, "error" in envelope ? envelope : { result: envelope.result })
      }
      sessions.receive(socket, frame)
    })
    send(socket, { type: "challenge", nonce: challenge })
  }

  const listen = (address: Extract<SettingsValue["remote"], { enabled: true }>) =>
    listenWebSockets({
      listen: (server, listening) => server.listen(address.port, address.bindHost, listening),
      accept,
      perMessageDeflate: true,
    }).pipe(
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
    Stream.runForEach(() => Effect.sync(() => sessions.closeAll(CLOSE_TOKEN_ROTATED, "token rotated"))),
    Effect.forkScoped,
  )
})

export const layer = Layer.effectDiscard(make)
