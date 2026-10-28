import { Option, Schema } from "effect"
import type { NonEmptyReadonlyArray } from "effect/Array"
import type { PushEvent, RpcEnvelope } from "@shared/contract.ts"
import { clientProof, newNonce, serverProof } from "@shared/proof.ts"
import {
  CHALLENGE_WAIT_MS,
  type ClientFrame,
  type Dial,
  DIRECT_CHECK_INTERVAL_MS,
  DIRECT_CHECK_TIMEOUT_MS,
  REMOTE_PROTOCOL_VERSION,
  ServerFrame,
} from "@shared/remote.ts"

export type TransportStatus = "connecting" | "connected" | "offline" | "unauthorized"

export interface ServerIdentity {
  readonly id: string
  readonly name: string
}

export class RpcError extends Error {
  constructor(
    readonly tag: string,
    message: string,
  ) {
    super(message)
  }
}

export const CLOSE_UNAUTHORIZED = 4001
export const CLOSE_TOKEN_ROTATED = 4002
export const CONNECT_TIMEOUT_MS = 10_000
export const PING_INTERVAL_MS = 10_000
export const IDLE_TIMEOUT_MS = 25_000
export const PROBE_TIMEOUT_MS = 5_000
export const OFFLINE_LIMIT_MS = 60_000
const MIN_RETRY_MS = 500
const MAX_RETRY_MS = 10_000
const JITTER = 0.3

export const NOT_SENT_MESSAGE = "Not sent. The desktop was unreachable for a minute."
export const MAY_HAVE_RUN_MESSAGE = "The desktop was unreachable for a minute. The action may still have run."
export const LOST_REPLY_MESSAGE = "The connection dropped before the desktop answered. The action may still have run."

export interface SocketLike {
  onopen: (() => void) | null
  onmessage: ((message: { data: unknown }) => void) | null
  onclose: ((event: { code: number }) => void) | null
  send(data: string): void
  close(): void
}

export interface TransportOptions {
  /** What to dial in each round, from `dialPlan`. */
  readonly dials: NonEmptyReadonlyArray<Dial>
  readonly token: string
  /** Whether `method` changes state on the desktop, so a retry must carry a call key. */
  readonly isMutation: (method: string) => boolean
  readonly onStatus: (status: TransportStatus, error: string | null) => void
  /**
   * Called on every handshake with the features this desktop understands, which HinaCode it is when it says, and
   * its relay hostname, null when it has none.
   */
  readonly onReady: (
    features: ReadonlySet<string>,
    environment: ServerIdentity | undefined,
    relay: string | null,
  ) => void
  /** Pushes were held back while the app was in the background, so what it shows must be read again. */
  readonly onMissed: () => void
  readonly onEvent: (event: PushEvent) => void
  readonly createSocket?: (url: string) => SocketLike
  readonly random?: () => number
  readonly newKey?: () => string
}

interface PendingCall {
  readonly id: number
  readonly method: string
  readonly payload: unknown
  readonly key: string | undefined
  sent: boolean
  unsafeToResend: boolean
  priorOfflineMs: number
  offlineSince: number | null
  readonly resolve: (envelope: RpcEnvelope<unknown>) => void
  readonly reject: (error: Error) => void
}

const decodeFrame = Schema.decodeUnknownOption(ServerFrame)

/**
 * What a round dials: the whole plan, or one route alone. A relay round follows a direct address that refused the
 * token, and its link checks no direct address. A direct round follows a direct check that answered.
 */
type Round = "both" | Dial["route"]

/** What the current socket was sent: nothing yet, the token itself, or a proof the server's `ready` must answer. */
type SentAuth = null | "token" | { readonly expectedProof: string }

const randomKey = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`

/**
 * Opens a socket for each of `dials` after its delay and hands the first one to open to `onOpen`. Every other socket
 * closes without a frame sent, so only the winner ever sees the token. `onFail` runs when every socket closed
 * before one opened. Returns a function that cancels the race and closes what it opened.
 */
function race(
  dials: readonly Dial[],
  createSocket: (url: string) => SocketLike,
  onOpen: (ws: SocketLike, dial: Dial) => void,
  onFail: () => void,
): () => void {
  const timers: ReturnType<typeof setTimeout>[] = []
  const live = new Set<SocketLike>()
  let started = 0
  let done = false
  const cancel = () => {
    done = true
    for (const timer of timers) clearTimeout(timer)
    for (const ws of live) ws.close()
    live.clear()
  }
  const start = (dial: Dial) => {
    started++
    const ws = createSocket(dial.url)
    live.add(ws)
    ws.onopen = () => {
      if (done) return ws.close()
      live.delete(ws)
      cancel()
      onOpen(ws, dial)
    }
    ws.onclose = () => {
      live.delete(ws)
      if (done || started < dials.length || live.size > 0) return
      cancel()
      onFail()
    }
  }
  for (const dial of dials) {
    if (dial.delayMs === 0) start(dial)
    else timers.push(setTimeout(() => !done && start(dial), dial.delayMs))
  }
  return cancel
}

export class Transport {
  private socket: SocketLike | null = null
  private status: TransportStatus = "offline"
  private features: ReadonlySet<string> = new Set()
  private attempt = 0
  private nextCallId = 1
  private foreground = true
  /** Back from a quiet stretch on this socket; the next frame proves the desktop is sending everything again. */
  private missedPushes = false
  private stopped = false
  private route: Dial["route"] | null = null
  private sentAuth: SentAuth = null
  private round: Round = "both"
  private cancelRace: (() => void) | undefined
  private cancelCheck: (() => void) | undefined
  private readonly pending = new Map<number, PendingCall>()
  private retryTimer: ReturnType<typeof setTimeout> | undefined
  private connectTimer: ReturnType<typeof setTimeout> | undefined
  private challengeTimer: ReturnType<typeof setTimeout> | undefined
  private idleTimer: ReturnType<typeof setTimeout> | undefined
  private pingTimer: ReturnType<typeof setInterval> | undefined
  private offlineTimer: ReturnType<typeof setTimeout> | undefined
  private checkTimer: ReturnType<typeof setInterval> | undefined
  private dials: NonEmptyReadonlyArray<Dial>

  constructor(private readonly options: TransportOptions) {
    this.dials = options.dials
  }

  start() {
    this.open()
  }

  /** Closes for good, failing every pending call. */
  stop() {
    this.stopped = true
    this.dropSocket()
    clearTimeout(this.retryTimer)
    clearTimeout(this.offlineTimer)
    this.failAll(new RpcError("Offline", "Disconnected from the desktop."))
  }

  /** Sends `payload` once it can, and resolves with the desktop's answer. */
  call(method: string, payload: unknown): Promise<RpcEnvelope<unknown>> {
    return new Promise((resolve, reject) => {
      if (this.stopped || this.status === "unauthorized") {
        reject(new RpcError("Offline", "Not connected to the desktop."))
        return
      }
      const call: PendingCall = {
        id: this.nextCallId++,
        method,
        payload,
        key: this.options.isMutation(method) ? (this.options.newKey ?? randomKey)() : undefined,
        sent: false,
        unsafeToResend: false,
        priorOfflineMs: 0,
        offlineSince: null,
        resolve,
        reject,
      }
      this.pending.set(call.id, call)
      if (this.status === "connected") this.sendCall(call)
      else {
        call.offlineSince = Date.now()
        this.expireOfflineCalls()
      }
    })
  }

  /** The network changed: the old TCP connection is likely dead even if it looks open, so start over now. */
  networkChanged() {
    if (this.stopped || this.status === "unauthorized") return
    this.redial()
  }

  /**
   * The app moved to or from the foreground. Timers do not run reliably in the background, so they stop, and a
   * desktop that can goes quiet until the app returns.
   */
  setForeground(foreground: boolean) {
    if (this.foreground === foreground) return
    this.foreground = foreground
    if (this.status === "connected" && this.features.has("quiet")) {
      this.sendFrame({ type: "quiet", quiet: !foreground })
      this.missedPushes = foreground
    }
    if (!foreground) {
      this.stopHeartbeat()
      this.stopDirectChecks()
      return
    }
    if (this.stopped || this.status === "unauthorized") return
    if (this.status === "connected") {
      if (this.checksDirect()) {
        this.checkDirect()
        this.startDirectChecks()
      }
      if (!this.features.has("heartbeat")) return
      this.ping()
      this.startPings()
      this.closeIfSilentFor(PROBE_TIMEOUT_MS)
    } else if (this.status === "offline") {
      this.reconnectNow()
    }
  }

  /** Dials `dials` from the next round on, keeping the current socket and every pending call. */
  setDials(dials: NonEmptyReadonlyArray<Dial>) {
    this.dials = dials
  }

  /** Skips the remaining backoff. */
  reconnectNow() {
    if (this.status !== "offline" || this.retryTimer === undefined) return
    clearTimeout(this.retryTimer)
    this.retryTimer = undefined
    this.open()
  }

  private open(round: Round = "both") {
    if (this.stopped) return
    this.retryTimer = undefined
    this.setStatus("connecting", null)
    this.round = round
    this.connectTimer = setTimeout(
      () => (this.socket === null ? this.noneOpened() : this.onLinkLost()),
      CONNECT_TIMEOUT_MS,
    )
    this.cancelRace = race(
      round === "both"
        ? this.dials
        : this.dials.filter((dial) => dial.route === round).map((dial) => ({ ...dial, delayMs: 0 })),
      this.createSocket,
      (ws, dial) => this.adopt(ws, dial.route),
      () => this.noneOpened(),
    )
  }

  /** The direct address a check found is gone again, so the relay may answer instead, without waiting. */
  private noneOpened() {
    if (this.round !== "direct") return this.onLinkLost()
    this.dropSocket()
    this.open("both")
  }

  private readonly createSocket = (url: string) =>
    (this.options.createSocket ?? ((url) => new WebSocket(url) as unknown as SocketLike))(url)

  private adopt(ws: SocketLike, route: Dial["route"]) {
    this.cancelRace = undefined
    this.socket = ws
    this.route = route
    // A server that predates the challenge only gets the token where a stranger cannot be listening: over the relay,
    // or on a pairing without one. A direct address of a pairing with a relay always runs a server that challenges.
    this.challengeTimer = setTimeout(() => {
      if (route === "relay" || !this.hasRelay()) {
        this.sentAuth = "token"
        this.sendFrame({ type: "auth", token: this.options.token })
      } else this.closed(CLOSE_UNAUTHORIZED, route)
    }, CHALLENGE_WAIT_MS)
    ws.onmessage = (message) => {
      if (this.socket === ws) this.receive(message.data, route)
    }
    ws.onclose = (event) => {
      if (this.socket === ws) this.closed(event.code, route)
    }
  }

  private closed(code: number, route: Dial["route"]) {
    // Away from home, a stranger's HinaCode can answer at the same LAN address and refuse a token the machine
    // still accepts, so only the relay, whose hostname is the machine's own, gets the last word.
    if (code === CLOSE_UNAUTHORIZED && route === "direct" && this.status === "connecting" && this.hasRelay()) {
      this.dropSocket()
      this.open("relay")
      return
    }
    if (code === CLOSE_UNAUTHORIZED || code === CLOSE_TOKEN_ROTATED) {
      this.dropSocket()
      this.unauthorized(
        code === CLOSE_TOKEN_ROTATED
          ? "The token was rotated on the desktop. Pair again with the new QR code."
          : "The desktop refused this token. Pair again from Settings > Remote.",
      )
      return
    }
    this.onLinkLost()
  }

  private hasRelay() {
    return this.dials.some((dial) => dial.route === "relay")
  }

  private answerChallenge(serverNonce: string) {
    if (this.sentAuth !== null) return
    clearTimeout(this.challengeTimer)
    const { token } = this.options
    const clientNonce = newNonce()
    this.sentAuth = { expectedProof: serverProof(token, clientNonce, serverNonce) }
    this.sendFrame({ type: "auth", nonce: clientNonce, proof: clientProof(token, serverNonce, clientNonce) })
  }

  /** Whether a `ready` came from a server that holds the token. One that only received the token itself cannot say. */
  private provesToken(proof: string | undefined) {
    return this.sentAuth === "token" || (this.sentAuth !== null && proof === this.sentAuth.expectedProof)
  }

  private receive(data: unknown, route: Dial["route"]) {
    if (typeof data !== "string") return
    let json: unknown
    try {
      json = JSON.parse(data)
    } catch {
      return
    }
    if (this.status === "connected") this.closeIfSilentFor(IDLE_TIMEOUT_MS)
    if (this.missedPushes) {
      this.missedPushes = false
      this.options.onMissed()
    }
    const frame = Option.getOrNull(decodeFrame(json))
    if (frame === null) return
    switch (frame.type) {
      case "challenge":
        return this.answerChallenge(frame.nonce)
      case "ready":
        if (!this.provesToken(frame.proof)) return this.closed(CLOSE_UNAUTHORIZED, route)
        return this.ready(frame.version, frame.features ?? [], frame.environment, frame.relay ?? null)
      case "result": {
        const call = this.pending.get(frame.id)
        this.pending.delete(frame.id)
        call?.resolve("error" in frame.envelope ? frame.envelope : { result: frame.envelope.result })
        if (call !== undefined) this.expireOfflineCalls()
        return
      }
      case "event":
        return this.options.onEvent(frame.event)
      case "pong":
        return
    }
  }

  private ready(
    version: number,
    features: readonly string[],
    environment: ServerIdentity | undefined,
    relay: string | null,
  ) {
    clearTimeout(this.connectTimer)
    if (version !== REMOTE_PROTOCOL_VERSION) {
      this.dropSocket()
      this.unauthorized(
        `The desktop speaks remote protocol ${version}, this app speaks ${REMOTE_PROTOCOL_VERSION}. Update the older one.`,
      )
      return
    }
    this.expireOfflineCalls()
    clearTimeout(this.offlineTimer)
    this.attempt = 0
    this.features = new Set(features)
    this.setStatus("connected", null)
    const now = Date.now()
    for (const call of [...this.pending.values()].sort((a, b) => a.id - b.id)) {
      if (call.offlineSince !== null) call.priorOfflineMs += now - call.offlineSince
      call.offlineSince = null
      this.sendCall(call)
    }
    if (this.features.has("heartbeat") && this.foreground) {
      this.startPings()
      this.closeIfSilentFor(IDLE_TIMEOUT_MS)
    }
    if (this.checksDirect() && this.foreground) this.startDirectChecks()
    if (this.features.has("quiet") && !this.foreground) this.sendFrame({ type: "quiet", quiet: true })
    this.options.onReady(this.features, environment, relay)
  }

  private sendCall(call: PendingCall) {
    const keyed = call.key !== undefined && this.features.has("call-keys")
    call.sent = true
    if (call.key !== undefined && !keyed) call.unsafeToResend = true
    const frame: ClientFrame = {
      type: "call",
      id: call.id,
      method: call.method,
      ...(call.payload === undefined ? {} : { payload: call.payload }),
      ...(keyed ? { key: call.key } : {}),
    }
    this.sendFrame(frame)
  }

  private sendFrame(frame: ClientFrame) {
    this.socket?.send(JSON.stringify(frame))
  }

  private ping() {
    this.sendFrame({ type: "ping", at: Date.now() })
  }

  private startPings() {
    clearInterval(this.pingTimer)
    this.pingTimer = setInterval(() => this.ping(), PING_INTERVAL_MS)
  }

  private closeIfSilentFor(ms: number) {
    if (!this.features.has("heartbeat") || !this.foreground) return
    clearTimeout(this.idleTimer)
    const ws = this.socket
    this.idleTimer = setTimeout(() => {
      if (this.socket === ws) this.onLinkLost()
    }, ms)
  }

  private stopHeartbeat() {
    clearInterval(this.pingTimer)
    clearTimeout(this.idleTimer)
    this.pingTimer = undefined
    this.idleTimer = undefined
  }

  private checksDirect() {
    return this.route === "relay" && this.round === "both"
  }

  private startDirectChecks() {
    clearInterval(this.checkTimer)
    this.checkTimer = setInterval(() => this.checkDirect(), DIRECT_CHECK_INTERVAL_MS)
  }

  private stopDirectChecks() {
    clearInterval(this.checkTimer)
    this.checkTimer = undefined
    this.cancelCheck?.()
  }

  /** Opens the direct addresses without the token. When one answers, the relay link gives way to a direct round. */
  private checkDirect() {
    const direct = this.dials.filter((dial) => dial.route === "direct")
    if (direct.length === 0) return
    this.cancelCheck?.()
    const cancelRace = race(
      direct,
      this.createSocket,
      (ws) => {
        ws.close()
        this.redial("direct")
      },
      () => this.cancelCheck?.(),
    )
    const timeout = setTimeout(() => this.cancelCheck?.(), DIRECT_CHECK_TIMEOUT_MS)
    this.cancelCheck = () => {
      clearTimeout(timeout)
      cancelRace()
      this.cancelCheck = undefined
    }
  }

  private redial(round: Round = "both") {
    this.onLinkLost()
    this.attempt = 0
    clearTimeout(this.retryTimer)
    this.open(round)
  }

  private onLinkLost() {
    this.dropSocket()
    const now = Date.now()
    for (const call of [...this.pending.values()]) {
      if (call.unsafeToResend) {
        this.pending.delete(call.id)
        call.reject(new RpcError("Offline", LOST_REPLY_MESSAGE))
      } else if (call.offlineSince === null) call.offlineSince = now
    }
    this.expireOfflineCalls()
    this.setStatus("offline", null)
    const base = Math.min(MAX_RETRY_MS, MIN_RETRY_MS * 2 ** this.attempt)
    const random = this.options.random ?? Math.random
    this.attempt++
    clearTimeout(this.retryTimer)
    this.retryTimer = setTimeout(() => this.open(), base * (1 + (random() * 2 - 1) * JITTER))
  }

  private dropSocket() {
    clearTimeout(this.connectTimer)
    clearTimeout(this.challengeTimer)
    this.sentAuth = null
    this.missedPushes = false
    this.stopHeartbeat()
    this.stopDirectChecks()
    this.cancelRace?.()
    this.cancelRace = undefined
    const ws = this.socket
    this.socket = null
    this.route = null
    ws?.close()
  }

  private unauthorized(error: string) {
    clearTimeout(this.retryTimer)
    clearTimeout(this.offlineTimer)
    this.retryTimer = undefined
    this.setStatus("unauthorized", error)
    this.failAll(new RpcError("Unauthorized", error))
  }

  private expireOfflineCalls() {
    clearTimeout(this.offlineTimer)
    const now = Date.now()
    let next = Infinity
    for (const call of [...this.pending.values()]) {
      if (call.offlineSince === null) continue
      const remaining = OFFLINE_LIMIT_MS - call.priorOfflineMs - (now - call.offlineSince)
      if (remaining > 0) {
        next = Math.min(next, remaining)
        continue
      }
      this.pending.delete(call.id)
      const mayHaveRun = call.sent && call.key !== undefined
      call.reject(new RpcError("Timeout", mayHaveRun ? MAY_HAVE_RUN_MESSAGE : NOT_SENT_MESSAGE))
    }
    if (next !== Infinity) this.offlineTimer = setTimeout(() => this.expireOfflineCalls(), next)
  }

  private failAll(error: Error) {
    for (const call of this.pending.values()) call.reject(error)
    this.pending.clear()
  }

  private setStatus(status: TransportStatus, error: string | null) {
    this.status = status
    this.options.onStatus(status, error)
  }
}
