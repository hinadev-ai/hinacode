import { Option, Schema } from "effect"
import type { NonEmptyReadonlyArray } from "effect/Array"
import type { PushEvent, RpcEnvelope } from "./contract.ts"
import { clientProof, newNonce, serverProof } from "./proof.ts"
import {
  CHALLENGE_WAIT_MS,
  type ClientFrame,
  type Dial,
  DIRECT_CHECK_INTERVAL_MS,
  DIRECT_CHECK_TIMEOUT_MS,
  REMOTE_PROTOCOL_VERSION,
  ServerFrame,
} from "./remote.ts"

export type TransportStatus = "connecting" | "connected" | "offline" | "unauthorized"

interface ServerIdentity {
  readonly id: string
  readonly name: string
}

export class RpcError extends Error {
  readonly tag: string

  constructor(tag: string, message: string) {
    super(message)
    this.tag = tag
  }
}

export const CLOSE_UNAUTHORIZED = 4001
export const CLOSE_TOKEN_ROTATED = 4002
export const CONNECT_TIMEOUT_MS = 10_000
const PING_INTERVAL_MS = 10_000
export const IDLE_TIMEOUT_MS = 25_000
export const PROBE_TIMEOUT_MS = 5_000
export const OFFLINE_LIMIT_MS = 60_000
const MIN_RETRY_MS = 500
const MAX_RETRY_MS = 10_000
const JITTER = 0.3

export interface SocketLike {
  onopen: (() => void) | null
  onmessage: ((message: { data: unknown }) => void) | null
  onclose: ((event: { code: number }) => void) | null
  send(data: string): void
  close(): void
}

export interface TransportMessages {
  readonly notSent: string
  readonly mayHaveRun: string
  readonly lostReply: string
  readonly disconnected: string
  readonly notConnected: string
  readonly tokenRotated: string
  readonly tokenRefused: string
  readonly protocolMismatch: (server: number, client: number) => string
}

interface TransportOptions {
  readonly dials: NonEmptyReadonlyArray<Dial>
  readonly token: string
  readonly messages: TransportMessages
  readonly compact: boolean
  readonly isMutation: (method: string) => boolean
  readonly onStatus: (status: TransportStatus, error: string | null) => void
  readonly onReady: (
    features: ReadonlySet<string>,
    environment: ServerIdentity | undefined,
    relay: string | null,
    hosts: NonEmptyReadonlyArray<string> | undefined,
  ) => void
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

type Round = "both" | Dial["route"]

type SentAuth = null | "token" | { readonly expectedProof: string }

const randomKey = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`

function raceToOpen(
  dials: readonly Dial[],
  createSocket: (url: string) => SocketLike,
  onFirstOpen: (ws: SocketLike, dial: Dial) => void,
  onAllClosed: () => void,
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
      onFirstOpen(ws, dial)
    }
    ws.onclose = () => {
      live.delete(ws)
      if (done || started < dials.length || live.size > 0) return
      cancel()
      onAllClosed()
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
  private watching: readonly string[] = []
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

  private readonly options: TransportOptions

  constructor(options: TransportOptions) {
    this.options = options
    this.dials = options.dials
  }

  start() {
    this.open()
  }

  stop() {
    this.stopped = true
    this.dropSocket()
    clearTimeout(this.retryTimer)
    clearTimeout(this.offlineTimer)
    this.failAll(new RpcError("Offline", this.options.messages.disconnected))
  }

  call(method: string, payload: unknown): Promise<RpcEnvelope<unknown>> {
    return new Promise((resolve, reject) => {
      if (this.stopped || this.status === "unauthorized") {
        reject(new RpcError("Offline", this.options.messages.notConnected))
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

  networkChanged() {
    if (this.stopped || this.status === "unauthorized") return
    if (!this.foreground) return this.onLinkLost()
    this.redial()
  }

  setForeground(foreground: boolean) {
    if (this.foreground === foreground) return
    this.foreground = foreground
    if (!foreground) {
      clearTimeout(this.retryTimer)
      this.retryTimer = undefined
      if (this.status === "connecting" || this.status === "connected") this.onLinkLost()
      return
    }
    if (this.stopped || this.status === "unauthorized") return
    if (this.status === "offline") this.reconnectNow()
  }

  setWatching(threadIds: readonly string[]) {
    this.watching = threadIds
    if (this.status === "connected") this.sendWatching()
  }

  private sendWatching() {
    if (this.options.compact && this.features.has("watch")) this.sendFrame({ type: "watch", threadIds: this.watching })
  }

  setDials(dials: NonEmptyReadonlyArray<Dial>) {
    const directUrls = (list: readonly Dial[]) =>
      list
        .filter((dial) => dial.route === "direct")
        .map((dial) => dial.url)
        .join(" ")
    const newDirect = directUrls(dials) !== directUrls(this.dials)
    this.dials = dials
    if (newDirect && this.status === "connected" && this.checksDirect() && this.foreground) this.checkDirect()
  }

  reconnectNow() {
    if (this.stopped || !this.foreground || this.status !== "offline") return
    clearTimeout(this.retryTimer)
    this.retryTimer = undefined
    this.open()
  }

  private open(round: Round = "both") {
    if (this.stopped || !this.foreground) return
    this.retryTimer = undefined
    this.setStatus("connecting", null)
    this.round = round
    this.connectTimer = setTimeout(() => {
      if (this.socket === null) this.noneOpened()
      else if (!this.triedRelayInstead(this.route!)) this.onLinkLost()
    }, CONNECT_TIMEOUT_MS)
    this.cancelRace = raceToOpen(
      round === "both"
        ? this.dials
        : this.dials
            .filter((dial) => dial.route === round)
            .map((dial) => (round === "relay" ? { ...dial, delayMs: 0 } : dial)),
      this.createSocket,
      (ws, dial) => this.adopt(ws, dial.route),
      () => this.noneOpened(),
    )
  }

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
    this.challengeTimer = setTimeout(() => {
      if (route === "relay" || !this.hasRelay()) {
        this.sentAuth = "token"
        this.sendFrame({ type: "auth", token: this.options.token, ...this.compactEvents() })
      } else this.closed(CLOSE_UNAUTHORIZED, route)
    }, CHALLENGE_WAIT_MS)
    ws.onmessage = (message) => {
      if (this.socket === ws) this.receive(message.data, route)
    }
    ws.onclose = (event) => {
      if (this.socket === ws) this.closed(event.code, route)
    }
  }

  private triedRelayInstead(route: Dial["route"]) {
    if (route !== "direct" || this.status !== "connecting" || !this.hasRelay()) return false
    this.dropSocket()
    this.open("relay")
    return true
  }

  private closed(code: number, route: Dial["route"]) {
    if (this.triedRelayInstead(route)) return
    if (code === CLOSE_UNAUTHORIZED || code === CLOSE_TOKEN_ROTATED) {
      this.dropSocket()
      this.unauthorized(
        code === CLOSE_TOKEN_ROTATED ? this.options.messages.tokenRotated : this.options.messages.tokenRefused,
      )
      return
    }
    this.onLinkLost()
  }

  private compactEvents() {
    return this.options.compact ? { compactEvents: true } : {}
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
    this.sendFrame({
      type: "auth",
      nonce: clientNonce,
      proof: clientProof(token, serverNonce, clientNonce),
      ...this.compactEvents(),
    })
  }

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
    const frame = Option.getOrNull(decodeFrame(json))
    if (frame === null) return
    switch (frame.type) {
      case "challenge":
        return this.answerChallenge(frame.nonce)
      case "ready":
        if (!this.provesToken(frame.proof)) return this.closed(CLOSE_UNAUTHORIZED, route)
        return this.ready(frame.version, frame.features ?? [], frame.environment, frame.relay ?? null, frame.hosts)
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
    hosts: NonEmptyReadonlyArray<string> | undefined,
  ) {
    clearTimeout(this.connectTimer)
    if (version !== REMOTE_PROTOCOL_VERSION) {
      this.dropSocket()
      this.unauthorized(this.options.messages.protocolMismatch(version, REMOTE_PROTOCOL_VERSION))
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
    this.sendWatching()
    this.options.onReady(this.features, environment, relay, hosts)
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

  private checkDirect() {
    const direct = this.dials.filter((dial) => dial.route === "direct")
    if (direct.length === 0) return
    this.cancelCheck?.()
    const cancelRace = raceToOpen(
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
    for (const call of this.pending.values()) {
      if (call.unsafeToResend) {
        this.pending.delete(call.id)
        call.reject(new RpcError("Offline", this.options.messages.lostReply))
      } else if (call.offlineSince === null) call.offlineSince = now
    }
    this.expireOfflineCalls()
    this.setStatus("offline", null)
    clearTimeout(this.retryTimer)
    this.retryTimer = undefined
    if (this.stopped || !this.foreground) return
    const base = Math.min(MAX_RETRY_MS, MIN_RETRY_MS * 2 ** this.attempt)
    const random = this.options.random ?? Math.random
    this.attempt++
    this.retryTimer = setTimeout(() => this.open(), base * (1 + (random() * 2 - 1) * JITTER))
  }

  private dropSocket() {
    clearTimeout(this.connectTimer)
    clearTimeout(this.challengeTimer)
    this.sentAuth = null
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
    for (const call of this.pending.values()) {
      if (call.offlineSince === null) continue
      const remaining = OFFLINE_LIMIT_MS - call.priorOfflineMs - (now - call.offlineSince)
      if (remaining > 0) {
        next = Math.min(next, remaining)
        continue
      }
      this.pending.delete(call.id)
      const mayHaveRun = call.sent && call.key !== undefined
      call.reject(
        new RpcError("Timeout", mayHaveRun ? this.options.messages.mayHaveRun : this.options.messages.notSent),
      )
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
