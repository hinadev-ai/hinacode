import { Option, Schema } from "effect"
import type { NonEmptyReadonlyArray } from "effect/Array"
import type { PushEvent, RpcEnvelope } from "@shared/contract.ts"
import { type ClientFrame, REMOTE_PROTOCOL_VERSION, ServerFrame } from "@shared/remote.ts"


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
  /** One socket URL per address of the desktop, in the pairing's order. */
  readonly urls: NonEmptyReadonlyArray<string>
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

const randomKey = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`

export class Transport {
  private socket: SocketLike | null = null
  private status: TransportStatus = "offline"
  private features: ReadonlySet<string> = new Set()
  private attempt = 0
  private nextCallId = 1
  private foreground = true
  private stopped = false
  private dialIndex = 0
  private lastConnectedIndex = 0
  private readonly pending = new Map<number, PendingCall>()
  private retryTimer: ReturnType<typeof setTimeout> | undefined
  private connectTimer: ReturnType<typeof setTimeout> | undefined
  private idleTimer: ReturnType<typeof setTimeout> | undefined
  private pingTimer: ReturnType<typeof setInterval> | undefined
  private offlineTimer: ReturnType<typeof setTimeout> | undefined
  private urls: NonEmptyReadonlyArray<string>

  constructor(private readonly options: TransportOptions) {
    this.urls = options.urls
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
    this.onLinkLost()
    this.attempt = 0
    this.dialIndex = this.lastConnectedIndex
    clearTimeout(this.retryTimer)
    this.open()
  }

  /** The app moved to or from the foreground. Timers do not run reliably in the background, so they stop. */
  setForeground(foreground: boolean) {
    if (this.foreground === foreground) return
    this.foreground = foreground
    if (!foreground) return this.stopHeartbeat()
    if (this.stopped || this.status === "unauthorized") return
    if (this.status === "connected") {
      if (!this.features.has("heartbeat")) return
      this.ping()
      this.startPings()
      this.closeIfSilentFor(PROBE_TIMEOUT_MS)
    } else if (this.status === "offline") {
      this.dialIndex = this.lastConnectedIndex
      this.reconnectNow()
    }
  }

  /**
   * Dials `urls` from the next attempt on, keeping the current socket and every pending call. A dial keeps
   * starting from the URL that last worked when the new list still has it.
   */
  setUrls(urls: NonEmptyReadonlyArray<string>) {
    const indexIn = (index: number) => Math.max(0, urls.indexOf(this.urls[index]!))
    this.dialIndex = indexIn(this.dialIndex)
    this.lastConnectedIndex = indexIn(this.lastConnectedIndex)
    this.urls = urls
  }

  /** Skips the remaining backoff. */
  reconnectNow() {
    if (this.status !== "offline" || this.retryTimer === undefined) return
    clearTimeout(this.retryTimer)
    this.retryTimer = undefined
    this.open()
  }

  private open() {
    if (this.stopped) return
    this.retryTimer = undefined
    this.setStatus("connecting", null)
    const url = this.urls[this.dialIndex]!
    const ws = (this.options.createSocket ?? ((url) => new WebSocket(url) as unknown as SocketLike))(url)
    this.socket = ws
    this.connectTimer = setTimeout(() => {
      if (this.socket === ws) this.onLinkLost()
    }, CONNECT_TIMEOUT_MS)
    ws.onopen = () => {
      if (this.socket === ws) this.sendFrame({ type: "auth", token: this.options.token })
    }
    ws.onmessage = (message) => {
      if (this.socket === ws) this.receive(message.data)
    }
    ws.onclose = (event) => {
      if (this.socket !== ws) return
      if (event.code === CLOSE_UNAUTHORIZED || event.code === CLOSE_TOKEN_ROTATED) {
        this.dropSocket()
        this.unauthorized(
          event.code === CLOSE_TOKEN_ROTATED
            ? "The token was rotated on the desktop. Pair again with the new QR code."
            : "The desktop refused this token. Pair again from Settings > Remote.",
        )
        return
      }
      this.onLinkLost()
    }
  }

  private receive(data: unknown) {
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
      case "ready":
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
    this.lastConnectedIndex = this.dialIndex
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

  
  private onLinkLost() {
    this.dialIndex =
      this.status === "connected" ? this.lastConnectedIndex : (this.dialIndex + 1) % this.urls.length
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
    this.stopHeartbeat()
    const ws = this.socket
    this.socket = null
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
