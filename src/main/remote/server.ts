import { type IncomingMessage, request as httpRequest, type ServerResponse } from "node:http"
import type { Socket } from "node:net"
import { pipeline } from "node:stream"
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js"
import { Cause, Duration, Effect, Fiber, FiberHandle, Layer, Option, Schema, Stream } from "effect"
import type { WebSocket } from "ws"
import { PRIVATE_NETWORKS, type Settings as SettingsValue } from "../../shared/domain.ts"
import {
  approvalCode,
  type Channel,
  commitment,
  encodeKey,
  newNonce as newApprovalNonce,
  REMOTE_PROLOGUE,
  respond,
} from "../../shared/noise.ts"
import { newNonce as newChallenge } from "../../shared/proof.ts"
import {
  type ClientFrame,
  CLOSE_AUTH_TIMEOUT,
  CLOSE_HANDSHAKE_FAILED,
  CLOSE_MALFORMED_FRAME,
  CLOSE_PAIRING_RESET,
  CLOSE_UNAUTHORIZED,
  isAddressNotUpYet,
  LegacyAuth,
  type LegacyChallenge,
  type LegacyReady,
  REMOTE_PRE_READY_MAX_BYTES,
  REMOTE_PROTOCOL_VERSION,
  REMOTE_SEALED_FRAME_BYTES,
  RemoteFeature,
} from "../../shared/remote.ts"
import { AppConnections } from "../apps/AppConnections.ts"
import { dispatchHere } from "../environments/route.ts"
import { isPrivateAddress } from "../network.ts"
import { PushBroadcast } from "../services/Events.ts"
import { Settings } from "../services/Settings.ts"
import { advertisedHosts, type Hello, RemoteAccess, relayHostname, type Waiting } from "./access.ts"
import { type Hub, Peers } from "./peers.ts"
import {
  describeError,
  listenWebSockets,
  makeSessions,
  parseClientFrame,
  retryUntilAddressIsUp,
  type SessionChannel,
  socketChannel,
} from "./session.ts"

const AUTH_TIMEOUT = Duration.seconds(5)
const APPROVAL_TIMEOUT = Duration.minutes(5)
const CLOSE_INTERNAL_ERROR = 1011

const decodeLegacyAuth = Schema.decodeUnknownOption(Schema.fromJsonString(LegacyAuth))
const utf8 = new TextDecoder("utf-8", { fatal: true })

interface Secured {
  readonly cipher: Channel
  readonly channel: SessionChannel
  readonly key: string
}

interface Introduced extends Secured {
  readonly hello: Hello
  readonly compactEvents: boolean
}

type Phase =
  | { readonly step: "opened" }
  | ({ readonly step: "handshaken" } & Secured)
  | ({ readonly step: "deciding" } & Introduced)
  | ({ readonly step: "pending"; readonly serverNonce: Uint8Array; readonly waiting: Waiting } & Introduced)
  | ({ readonly step: "approving"; readonly waiting: Waiting } & Introduced)
  | ({ readonly step: "ready"; hub: Hub | null; readonly disconnect: () => void } & Secured)
  | { readonly step: "closed" }

const openFrame = (cipher: Channel, raw: Buffer): ClientFrame | undefined => {
  try {
    return parseClientFrame(utf8.decode(cipher.decrypt(raw)))
  } catch {
    return undefined
  }
}

const sendPlain = (socket: WebSocket, frame: typeof LegacyChallenge.Encoded | typeof LegacyReady.Encoded) =>
  socket.send(JSON.stringify(frame))

const describeCause = (cause: Cause.Cause<unknown>) => describeError(Cause.squash(cause))

const staysOnPrivateNetworks = (socket: Socket) =>
  [socket.localAddress, socket.remoteAddress].every((address) => address !== undefined && isPrivateAddress(address))

const hostnameOf = (host: string | undefined) =>
  host !== undefined && URL.canParse(`http://${host}`) ? new URL(`http://${host}`).hostname : null

const ignoreStreamEnd = () => {}

const forward = (port: number, request: IncomingMessage, response: ServerResponse) => {
  const upstream = httpRequest(
    {
      host: "127.0.0.1",
      port,
      method: request.method,
      path: request.url,
      headers: request.headers,
      agent: false,
    },
    (answer) => {
      response.writeHead(answer.statusCode ?? 502, answer.headers)
      pipeline(answer, response, ignoreStreamEnd)
    },
  )
  upstream.on("error", () => {
    if (response.headersSent) return void response.destroy()
    response.writeHead(502).end()
  })
  response.on("close", () => upstream.destroy())
  pipeline(request, upstream, ignoreStreamEnd)
}

const make = Effect.gen(function* () {
  const access = yield* RemoteAccess
  const apps = yield* AppConnections
  const broadcast = yield* PushBroadcast
  const settings = yield* Settings
  const peers = yield* Peers
  const runFork = Effect.runForkWith(yield* Effect.context<never>())

  let current = (yield* settings.get).remote

  const sessions = yield* makeSessions({
    call: (raw) => dispatchHere(raw, null),
    subscribe: broadcast.subscribe,
    environment: access.identity,
    features: RemoteFeature,
    remote: true,
  })
  const sockets = new Set<WebSocket>()
  const countConnected = () => runFork(access.report({ connected: sessions.count() }))

  const forwardToApps = (request: IncomingMessage, response: ServerResponse) => {
    const relay = relayHostname(Effect.runSync(access.status).relay)
    const port = apps.port()
    if (relay === null || port === null || hostnameOf(request.headers.host) !== relay.toLowerCase()) {
      return void response.writeHead(404).end()
    }
    forward(port, request, response)
  }

  const accept = (socket: WebSocket) => {
    const challenge = newChallenge()
    let phase: Phase = { step: "opened" }
    let approvalDeadline: Fiber.Fiber<void> | null = null
    sockets.add(socket)

    const close = (code: number, reason: string) => socket.close(code, reason)
    const isOpen = () => socket.readyState === socket.OPEN
    const malformed = () => close(CLOSE_MALFORMED_FRAME, "malformed frame")

    const helloDeadline = runFork(
      Effect.sleep(AUTH_TIMEOUT).pipe(Effect.andThen(Effect.sync(() => close(CLOSE_AUTH_TIMEOUT, "auth timeout")))),
    )

    const answerLegacy = (raw: Buffer) => {
      const auth = Option.getOrUndefined(decodeLegacyAuth(raw.toString("utf8")))
      if (auth === undefined) return malformed()
      const answer = access.answerLegacy(challenge, auth)
      if (answer === null) return close(CLOSE_UNAUTHORIZED, "unauthorized")
      sendPlain(socket, { type: "ready", version: REMOTE_PROTOCOL_VERSION, ...answer })
      close(1000, "this app predates end-to-end encryption")
    }

    const handshake = (raw: Buffer) => {
      try {
        const responder = respond({ prologue: REMOTE_PROLOGUE, local: access.hostKey(), message: raw })
        const { message, channel: cipher } = responder.reply(new Uint8Array(0))
        socket.send(message)
        const channel = socketChannel(socket, (json) => cipher.encrypt(utf8ToBytes(json)))
        phase = { step: "handshaken", cipher, channel, key: encodeKey(responder.remoteStatic) }
      } catch {
        close(CLOSE_HANDSHAKE_FAILED, "handshake failed")
      }
    }

    const ready = ({ cipher, channel, key }: Secured, compactEvents: boolean) => {
      if (!isOpen()) return
      if (approvalDeadline !== null) runFork(Fiber.interrupt(approvalDeadline))
      const relay = relayHostname(Effect.runSync(access.status).relay) ?? undefined
      sessions.attach(channel, { compactEvents, relay, hosts: advertisedHosts(current.bindHost) })
      const disconnect = access.connect(key, close)
      phase = { step: "ready", cipher, channel, key, hub: null, disconnect }
      countConnected()
      channel.onClose(countConnected)
    }

    const waitForApproval = (introduced: Introduced) => {
      const serverNonce = newApprovalNonce()
      const waiting = access.wait({
        key: introduced.key,
        name: introduced.hello.name,
        admit: () => {
          if (phase.step === "approving") ready(phase, phase.compactEvents)
        },
        close,
      })
      phase = { ...introduced, step: "pending", serverNonce, waiting }
      approvalDeadline = runFork(
        Effect.sleep(APPROVAL_TIMEOUT).pipe(
          Effect.andThen(Effect.sync(() => close(CLOSE_UNAUTHORIZED, "approval timed out"))),
        ),
      )
      introduced.channel.send({ type: "pending", commitment: bytesToHex(commitment(serverNonce)) })
    }

    const hello = (secured: Secured, frame: Extract<ClientFrame, { type: "hello" }>) => {
      runFork(Fiber.interrupt(helloDeadline))
      const introduced: Introduced = {
        ...secured,
        hello: { key: secured.key, name: frame.name, secret: frame.secret, verify: frame.verify },
        compactEvents: frame.compactEvents ?? false,
      }
      phase = { ...introduced, step: "deciding" }
      runFork(
        access.admit(introduced.hello).pipe(
          Effect.match({
            onFailure: () => close(CLOSE_INTERNAL_ERROR, "could not check this device"),
            onSuccess: (decision) => {
              if (phase.step !== "deciding" || !isOpen()) return
              if (decision === "ready") ready(introduced, introduced.compactEvents)
              else waitForApproval(introduced)
            },
          }),
        ),
      )
    }

    const approval = (
      pending: Extract<Phase, { step: "pending" }>,
      frame: Extract<ClientFrame, { type: "approval" }>,
    ) => {
      pending.channel.send({ type: "approval", nonce: bytesToHex(pending.serverNonce) })
      const code = approvalCode(pending.cipher.handshakeHash, hexToBytes(frame.nonce), pending.serverNonce)
      phase = { ...pending, step: "approving" }
      runFork(pending.waiting.showsCode(code))
    }

    const receiveBeforeReady = (waiting: Exclude<Phase, { step: "opened" | "ready" | "closed" }>, raw: Buffer) => {
      const frame = openFrame(waiting.cipher, raw)
      if (frame === undefined) return malformed()
      if (waiting.step === "handshaken") return frame.type === "hello" ? hello(waiting, frame) : malformed()
      if (frame.type === "ping") return waiting.channel.send({ type: "pong", at: frame.at })
      if (waiting.step === "pending" && frame.type === "approval") return approval(waiting, frame)
      malformed()
    }

    const receiveSession = (session: Extract<Phase, { step: "ready" }>, raw: Buffer, isBinary: boolean) => {
      const frame = isBinary ? openFrame(session.cipher, raw) : undefined
      if (frame === undefined || frame.type === "hello" || frame.type === "approval") return malformed()
      if (frame.type === "hub") return void (session.hub ??= peers.join((ask) => session.channel.send(ask)))
      if (frame.type === "answer") {
        const { envelope } = frame
        return session.hub?.answer(frame.id, "error" in envelope ? envelope : { result: envelope.result })
      }
      sessions.receive(session.channel, frame)
    }

    socket.on("close", () => {
      sockets.delete(socket)
      runFork(Fiber.interrupt(helloDeadline))
      if (approvalDeadline !== null) runFork(Fiber.interrupt(approvalDeadline))
      if (phase.step === "pending" || phase.step === "approving") phase.waiting.leave()
      if (phase.step === "ready") {
        phase.hub?.leave()
        phase.disconnect()
      }
      phase = { step: "closed" }
    })
    socket.on("error", () => {})
    socket.on("message", (raw: Buffer, isBinary) => {
      // FIXME: ws still emits frames that arrive during the close handshake
      if (!isOpen() || phase.step === "closed") return
      if (phase.step === "ready") return receiveSession(phase, raw, isBinary)
      if (raw.length > REMOTE_PRE_READY_MAX_BYTES) return malformed()
      if (phase.step === "opened") return isBinary ? handshake(raw) : answerLegacy(raw)
      if (!isBinary) return malformed()
      receiveBeforeReady(phase, raw)
    })
    sendPlain(socket, { type: "challenge", nonce: challenge })
  }

  const listen = (address: SettingsValue["remote"]) =>
    listenWebSockets({
      listen: (server, listening) => {
        const everyInterface = address.bindHost === PRIVATE_NETWORKS
        if (everyInterface)
          server.on("connection", (socket) => {
            if (!staysOnPrivateNetworks(socket)) socket.destroy()
          })
        server.listen(address.port, everyInterface ? "0.0.0.0" : address.bindHost, listening)
      },
      accept,
      maxPayload: REMOTE_SEALED_FRAME_BYTES,
      request: forwardToApps,
    }).pipe(
      Effect.tapError(({ message }) =>
        isAddressNotUpYet(message)
          ? access
              .report({ listenError: message })
              .pipe(Effect.andThen(Effect.logWarning("remote address is not up yet, retrying", message)))
          : Effect.void,
      ),
      retryUntilAddressIsUp,
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
  yield* access.resets.pipe(
    Stream.runForEach(() =>
      Effect.sync(() => {
        for (const socket of sockets) socket.close(CLOSE_PAIRING_RESET, "pairing reset")
      }),
    ),
    Effect.forkScoped,
  )
})

export const layer = Layer.effectDiscard(make)
