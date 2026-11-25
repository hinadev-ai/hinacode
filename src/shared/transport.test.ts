import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { TRANSCRIPT_PAGE_BYTES } from "./compactTranscript.ts"
import type { HostApproval, HostRefusal } from "./domain.ts"
import {
  approvalCode,
  type Channel,
  commitment,
  encodeKey,
  generateKeyPair,
  type KeyPair,
  newNonce,
  REMOTE_PROLOGUE,
  respond,
} from "./noise.ts"
import {
  CLOSE_HANDSHAKE_FAILED,
  CLOSE_PAIRING_RESET,
  CLOSE_UNAUTHORIZED,
  DIRECT_CHECK_INTERVAL_MS,
  DIRECT_CHECK_TIMEOUT_MS,
  type Dial,
  dialPlan,
  RELAY_DELAY_MS,
  TAILSCALE_DELAY_MS,
} from "./remote.ts"
import {
  CONNECT_TIMEOUT_MS,
  type SocketLike,
  Transport,
  type TransportMessages,
  type TransportStatus,
  IDLE_TIMEOUT_MS,
} from "./transport.ts"

const HOST = generateKeyPair()
const DEVICE = generateKeyPair()
const SECRET = "pairing-secret"

const MESSAGES: TransportMessages = {
  notSent: "not sent",
  mayHaveRun: "may have run",
  lostReply: "lost reply",
  disconnected: "disconnected",
  notConnected: "not connected",
  refusal: (refusal) => `refusal ${refusal}`,
  protocolMismatch: (server, client) => `protocol ${server} vs ${client}`,
}

const jumpClock = (ms: number) => vi.setSystemTime(vi.getMockedSystemTime()!.getTime() + ms)

const utf8 = new TextDecoder()

const arrayBuffer = (bytes: Uint8Array) => bytes.slice().buffer

class FakeSocket implements SocketLike {
  binaryType = "blob"
  onopen: (() => void) | null = null
  onmessage: ((message: { data: unknown }) => void) | null = null
  onclose: ((event: { code: number }) => void) | null = null
  readonly raw: unknown[] = []
  readonly sent: Record<string, unknown>[] = []
  closed = false
  channel: Channel | null = null
  serverNonce: Uint8Array | null = null

  readonly url: string

  constructor(url: string) {
    this.url = url
  }

  send(data: Uint8Array) {
    this.raw.push(data)
    if (this.channel !== null) this.sent.push(JSON.parse(utf8.decode(this.channel.decrypt(data))))
  }
  close() {
    this.closed = true
  }

  open() {
    this.onopen?.()
  }
  answer(host: KeyPair = HOST) {
    this.onmessage?.({ data: JSON.stringify({ type: "challenge", nonce: "legacy-nonce" }) })
    if (this.raw.length === 0) return
    const responder = respond({ prologue: REMOTE_PROLOGUE, local: host, message: this.raw[0] as Uint8Array })
    const { message, channel } = responder.reply(new Uint8Array(0))
    this.channel = channel
    this.onmessage?.({ data: arrayBuffer(message) })
  }
  impersonate() {
    this.onmessage?.({ data: JSON.stringify({ type: "challenge", nonce: "legacy-nonce" }) })
    this.onmessage?.({ data: arrayBuffer(generateKeyPair().secretKey.slice(0, 48)) })
  }
  hello() {
    return this.sent.find((frame) => frame.type === "hello")
  }
  pend() {
    this.serverNonce = newNonce()
    this.receive({ type: "pending", commitment: bytesToHex(commitment(this.serverNonce)) })
  }
  reveal(nonce = this.serverNonce!) {
    this.receive({ type: "approval", nonce: bytesToHex(nonce) })
  }
  code() {
    const sent = this.sent.find((frame) => frame.type === "approval")!
    return approvalCode(this.channel!.handshakeHash, hexToBytes(sent.nonce as string), this.serverNonce!)
  }
  ready(features: readonly string[] = ["heartbeat", "call-keys", "terminal-attach"], version = 2) {
    this.receive({ type: "ready", version, features })
  }
  receive(frame: unknown) {
    if (this.channel === null) return
    this.onmessage?.({ data: arrayBuffer(this.channel!.encrypt(utf8ToBytes(JSON.stringify(frame)))) })
  }
  result(id: unknown, result: unknown = null) {
    this.receive({ type: "result", id, envelope: { result } })
  }
  drop(code = 1006) {
    this.onclose?.({ code })
  }
  calls() {
    return this.sent.filter((frame) => frame.type === "call")
  }
  pings() {
    return this.sent.filter((frame) => frame.type === "ping")
  }
}

const MUTATIONS = new Set(["threads.send", "approvals.respond"])

let sockets: FakeSocket[]
let statuses: TransportStatus[]
let errors: (string | null)[]
let refusals: (HostRefusal | null)[]
let approvals: (HostApproval | null)[]
let secretUsed: number
let verified: number
let ready: number
let received: number
let keys: number

const direct = (url: string): Dial => ({ url, route: "direct", delayMs: 0 })
const relay = (url: string): Dial => ({ url, route: "relay", delayMs: RELAY_DELAY_MS })

interface Pairing {
  readonly compact?: boolean
  readonly hostKey?: string | null
  readonly secret?: string | null
  readonly verified?: boolean
}

function setup(
  dials: readonly [Dial, ...Dial[]] = [direct("ws://desktop/remote")],
  { compact = true, hostKey = encodeKey(HOST.publicKey), secret = null, verified: pinned = true }: Pairing = {},
) {
  sockets = []
  statuses = []
  errors = []
  refusals = []
  approvals = []
  secretUsed = 0
  verified = 0
  ready = 0
  received = 0
  keys = 0
  const transport = new Transport({
    dials,
    hostKey,
    device: DEVICE,
    name: "Pixel",
    secret,
    verified: pinned,
    messages: MESSAGES,
    compact,
    isMutation: (method) => MUTATIONS.has(method),
    onStatus: (status, error, refusal) => {
      statuses.push(status)
      errors.push(error)
      refusals.push(refusal)
    },
    onReady: () => ready++,
    onEvent: () => received++,
    onSecretUsed: () => secretUsed++,
    onApproval: (approval) => approvals.push(approval),
    onVerified: () => verified++,
    createSocket: (url) => {
      const socket = new FakeSocket(url)
      sockets.push(socket)
      return socket
    },
    random: () => 0.5,
    newKey: () => `key-${++keys}`,
  })
  transport.start()
  return transport
}

const latest = () => sockets.at(-1)!
const socketAt = (url: string) => sockets.findLast((socket) => socket.url === url)!
const urls = () => sockets.map((socket) => socket.url)

function handshake(features?: readonly string[]) {
  latest().open()
  latest().answer()
  latest().ready(features)
}

function awaitCode(options: Pairing = {}) {
  const transport = setup(undefined, options)
  latest().open()
  latest().answer()
  latest().pend()
  latest().reveal()
  return transport
}

function track<T>(promise: Promise<T>) {
  const state: { value?: T; error?: Error } = {}
  promise.then(
    (value) => (state.value = value),
    (error: Error) => (state.error = error),
  )
  return state
}

beforeEach(() => {
  vi.useFakeTimers()
  sockets = []
})
afterEach(() => {
  vi.useRealTimers()
  for (const socket of sockets) expect(socket.raw.every((data) => data instanceof Uint8Array)).toBe(true)
  for (const socket of sockets) expect(socket.binaryType).toBe("arraybuffer")
})

describe("Transport", () => {
  it("opens with the handshake, says hello with compact events, and connects on ready", () => {
    setup()
    expect(statuses).toEqual(["connecting"])
    latest().open()
    expect(latest().raw).toHaveLength(1)
    latest().answer()
    expect(latest().sent).toEqual([{ type: "hello", name: "Pixel", compactEvents: true }])
    expect(statuses.at(-1)).toBe("connecting")
    latest().ready()
    expect(statuses.at(-1)).toBe("connected")
    expect(ready).toBe(1)
  })

  it("leaves compact events out of its hello when not compact", () => {
    setup(undefined, { compact: false })
    latest().open()
    latest().answer()
    expect(latest().sent).toEqual([{ type: "hello", name: "Pixel" }])
  })

  it("queues a call made while connecting and sends it after ready", async () => {
    const transport = setup()
    const result = transport.call("threads.list", undefined)
    expect(latest().calls()).toEqual([])
    handshake()
    expect(latest().calls()).toEqual([{ type: "call", id: 1, method: "threads.list" }])
    latest().result(1, ["thread"])
    await expect(result).resolves.toEqual({ result: ["thread"] })
  })

  it("retries a mutation after a drop with the same key, in order", async () => {
    const transport = setup()
    handshake()
    const send = track(transport.call("threads.send", { prompt: "hi" }))
    const read = track(transport.call("threads.list", undefined))
    const allow = track(transport.call("approvals.respond", { decision: "allow" }))
    expect(
      latest()
        .calls()
        .map((frame) => frame.key),
    ).toEqual(["key-1", undefined, "key-2"])

    latest().drop()
    expect(statuses.at(-1)).toBe("offline")
    await vi.advanceTimersByTimeAsync(500)
    handshake()

    expect(latest().calls()).toEqual([
      { type: "call", id: 1, method: "threads.send", payload: { prompt: "hi" }, key: "key-1" },
      { type: "call", id: 2, method: "threads.list" },
      { type: "call", id: 3, method: "approvals.respond", payload: { decision: "allow" }, key: "key-2" },
    ])
    latest().result(1)
    latest().result(2, [])
    latest().result(3)
    await vi.advanceTimersByTimeAsync(0)
    expect([send.error, read.error, allow.error]).toEqual([undefined, undefined, undefined])
    expect(read.value).toEqual({ result: [] })
  })

  it("ignores a result from a socket it already dropped", async () => {
    const transport = setup()
    handshake()
    const send = track(transport.call("threads.send", {}))
    const old = latest()
    old.drop()
    old.result(1, "stale")
    await vi.advanceTimersByTimeAsync(0)
    expect(send).toEqual({})
  })

  describe("offline timeout", () => {
    it("fails an unsent call after 60 s offline in total, not counting time connected", async () => {
      const transport = setup()
      const send = track(transport.call("threads.send", {}))

      await vi.advanceTimersByTimeAsync(9_000)
      latest().drop()
      await vi.advanceTimersByTimeAsync(21_000)
      expect(send.error).toBeUndefined()
      handshake()
      await vi.advanceTimersByTimeAsync(20_000)
      expect(send.error).toBeUndefined()
      latest().drop()
      await vi.advanceTimersByTimeAsync(29_999)
      expect(send.error).toBeUndefined()
      await vi.advanceTimersByTimeAsync(1)
      expect(send.error).toMatchObject({ tag: "Timeout", message: MESSAGES.mayHaveRun })
    })

    it("says not sent when the call never left the phone", async () => {
      const transport = setup()
      const send = track(transport.call("threads.send", {}))
      await vi.advanceTimersByTimeAsync(60_000)
      expect(send.error).toMatchObject({ tag: "Timeout", message: MESSAGES.notSent })
    })

    it("expires a call on ready when the clock jumped past the limit before its timer ran", async () => {
      const transport = setup()
      const send = track(transport.call("threads.send", {}))
      const read = track(transport.call("threads.list", undefined))
      jumpClock(61_000)
      handshake()
      await vi.advanceTimersByTimeAsync(0)
      expect(latest().calls()).toEqual([])
      expect(send.error).toMatchObject({ tag: "Timeout", message: MESSAGES.notSent })
      expect(read.error).toMatchObject({ tag: "Timeout", message: MESSAGES.notSent })
    })

    it("counts earlier outages when a late ready arrives", async () => {
      const transport = setup()
      handshake()
      const send = track(transport.call("threads.send", {}))
      latest().drop()
      await vi.advanceTimersByTimeAsync(400)
      jumpClock(30_000)
      await vi.advanceTimersByTimeAsync(100)
      handshake()
      expect(latest().calls()).toHaveLength(1)

      latest().drop()
      await vi.advanceTimersByTimeAsync(400)
      jumpClock(29_600)
      await vi.advanceTimersByTimeAsync(100)
      const before = latest().calls().length
      handshake()
      await vi.advanceTimersByTimeAsync(0)
      expect(latest().calls()).toHaveLength(before)
      expect(send.error).toMatchObject({ tag: "Timeout", message: MESSAGES.mayHaveRun })
    })

    it("still sends a call whose outage stayed under the limit", async () => {
      const transport = setup()
      const send = track(transport.call("threads.send", {}))
      jumpClock(59_000)
      handshake()
      expect(latest().calls()).toHaveLength(1)
      latest().result(1)
      await vi.advanceTimersByTimeAsync(0)
      expect(send.value).toEqual({ result: null })
    })

    it("never times out a call that waits on a live link", async () => {
      const transport = setup()
      handshake(["call-keys"])
      const clone = track(transport.call("threads.send", {}))
      await vi.advanceTimersByTimeAsync(5 * 60_000)
      expect(clone).toEqual({})
      latest().result(1)
      await vi.advanceTimersByTimeAsync(0)
      expect(clone.value).toEqual({ result: null })
    })
  })

  describe("connect timeout", () => {
    it("closes a socket that has not said ready within 10 s and retries", async () => {
      setup()
      latest().open()
      await vi.advanceTimersByTimeAsync(9_999)
      expect(latest().closed).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      expect(sockets[0]!.closed).toBe(true)
      expect(statuses.at(-1)).toBe("offline")
      await vi.advanceTimersByTimeAsync(500)
      expect(sockets).toHaveLength(2)
    })
  })

  describe("backoff", () => {
    it("doubles from 0.5 s up to 10 s and resets after ready", async () => {
      setup()
      const delays: number[] = []
      for (let i = 0; i < 7; i++) {
        const before = sockets.length
        latest().drop()
        let waited = 0
        while (sockets.length === before) {
          await vi.advanceTimersByTimeAsync(100)
          waited += 100
        }
        delays.push(waited)
      }
      expect(delays).toEqual([500, 1_000, 2_000, 4_000, 8_000, 10_000, 10_000])

      handshake()
      latest().drop()
      await vi.advanceTimersByTimeAsync(500)
      expect(statuses.at(-1)).toBe("connecting")
    })

    it("applies up to 30% jitter", async () => {
      sockets = []
      const transport = new Transport({
        dials: [direct("ws://desktop/remote")],
        hostKey: encodeKey(HOST.publicKey),
        device: DEVICE,
        name: "Pixel",
        secret: null,
        verified: true,
        messages: MESSAGES,
        compact: true,
        isMutation: () => false,
        onStatus: () => {},
        onReady: () => {},
        onEvent: () => {},
        onSecretUsed: () => {},
        onApproval: () => {},
        onVerified: () => {},
        createSocket: (url) => {
          const socket = new FakeSocket(url)
          sockets.push(socket)
          return socket
        },
        random: () => 0,
      })
      transport.start()
      latest().drop()
      await vi.advanceTimersByTimeAsync(349)
      expect(sockets).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(1)
      expect(sockets).toHaveLength(2)
    })

    it.each([4003, 4004, 4005, 4006, 1006])("retries after close code %i", async (code) => {
      setup()
      latest().drop(code)
      await vi.advanceTimersByTimeAsync(500)
      expect(sockets).toHaveLength(2)
    })

    it.each([
      [CLOSE_UNAUTHORIZED, "removed"],
      [CLOSE_PAIRING_RESET, "reset"],
    ] as const)("stops after close code %i on a live link and fails pending calls", async (code, refusal) => {
      const transport = setup()
      handshake()
      const send = track(transport.call("threads.send", {}))
      latest().drop(code)
      await vi.advanceTimersByTimeAsync(60_000)
      expect(sockets).toHaveLength(1)
      expect(statuses.at(-1)).toBe("unauthorized")
      expect(refusals.at(-1)).toBe(refusal)
      expect(errors.at(-1)).toBe(`refusal ${refusal}`)
      expect(send.error).toMatchObject({ tag: "Unauthorized" })
    })
  })

  describe("heartbeat", () => {
    it("pings every 10 s and closes after exactly 25 s without a frame", async () => {
      setup()
      handshake()
      await vi.advanceTimersByTimeAsync(10_000)
      expect(latest().pings()).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(14_999)
      expect(latest().pings()).toHaveLength(2)
      expect(latest().closed).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      expect(sockets[0]!.closed).toBe(true)
      expect(statuses.at(-1)).toBe("offline")
    })

    it("counts any frame as alive, measuring 25 s from the last one", async () => {
      setup()
      handshake()
      await vi.advanceTimersByTimeAsync(20_000)
      latest().receive({ type: "pong", at: 0 })
      await vi.advanceTimersByTimeAsync(24_999)
      expect(latest().closed).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      expect(latest().closed).toBe(true)
    })
  })

  describe("background cutoff", () => {
    it("closes a healthy socket and does no socket work until the foreground", async () => {
      const transport = setup()
      handshake()
      const backgroundSocket = latest()
      backgroundSocket.receive({ type: "event", event: { type: "thread.removed", id: "visible" } })
      expect(received).toBe(1)
      const sent = backgroundSocket.sent.length
      transport.setForeground(false)
      expect(backgroundSocket.closed).toBe(true)
      expect(statuses.at(-1)).toBe("offline")
      expect(vi.getTimerCount()).toBe(0)
      backgroundSocket.receive({ type: "event", event: { type: "thread.removed", id: "hidden" } })
      await vi.advanceTimersByTimeAsync(60_000)
      expect(received).toBe(1)
      expect(backgroundSocket.sent).toHaveLength(sent)
      expect(sockets).toHaveLength(1)
      expect(vi.getTimerCount()).toBe(0)
      transport.setForeground(true)
      expect(sockets).toHaveLength(2)
      handshake()
      expect(ready).toBe(2)
      latest().receive({ type: "event", event: { type: "thread.removed", id: "visible-again" } })
      expect(received).toBe(2)
    })

    it("replays a pending mutation once with the same call key after returning", async () => {
      const transport = setup()
      handshake(["heartbeat", "call-keys"])
      const sending = track(transport.call("threads.send", { prompt: "hi" }))
      const backgroundSocket = latest()
      transport.setForeground(false)
      backgroundSocket.result(1, "late")
      await vi.advanceTimersByTimeAsync(30_000)
      expect(sending.value).toBeUndefined()
      expect(sending.error).toBeUndefined()
      expect(sockets).toHaveLength(1)
      transport.setForeground(true)
      handshake(["heartbeat", "call-keys"])
      expect(backgroundSocket.calls()).toEqual([
        { type: "call", id: 1, method: "threads.send", payload: { prompt: "hi" }, key: "key-1" },
      ])
      expect(latest().calls()).toEqual(backgroundSocket.calls())
      latest().result(1, "finished")
      await vi.advanceTimersByTimeAsync(0)
      expect(sending.value).toEqual({ result: "finished" })
    })

    it("fails an unkeyed pending mutation on background cutoff instead of replaying it", async () => {
      const transport = setup()
      handshake([])
      const sending = track(transport.call("threads.send", { prompt: "hi" }))
      transport.setForeground(false)
      await vi.advanceTimersByTimeAsync(0)
      expect(sending.error).toMatchObject({ tag: "Offline", message: MESSAGES.lostReply })
      transport.setForeground(true)
      handshake([])
      expect(latest().calls()).toEqual([])
    })

    it("makes no connection attempts for a minute after its background socket drops", async () => {
      const transport = setup()
      handshake(["heartbeat"])
      transport.setForeground(false)
      latest().drop()
      await vi.advanceTimersByTimeAsync(60_000)
      expect(sockets).toHaveLength(1)
      expect(statuses.at(-1)).toBe("offline")
      transport.setForeground(true)
      expect(sockets).toHaveLength(2)
      expect(statuses.at(-1)).toBe("connecting")
    })

    it("cancels a scheduled retry when the app leaves", async () => {
      const transport = setup()
      latest().drop()
      transport.setForeground(false)
      await vi.advanceTimersByTimeAsync(60_000)
      expect(sockets).toHaveLength(1)
      transport.setForeground(true)
      expect(sockets).toHaveLength(2)
    })

    it("ends a connection race when the app leaves and resumes it once on return", async () => {
      const transport = setup([direct("ws://desktop/remote"), relay("wss://relay/remote")])
      transport.setForeground(false)
      await vi.advanceTimersByTimeAsync(60_000)
      expect(sockets).toHaveLength(1)
      expect(sockets[0]!.closed).toBe(true)
      transport.setForeground(true)
      expect(sockets).toHaveLength(2)
      handshake(["heartbeat"])
      expect(statuses.at(-1)).toBe("connected")
    })

    it("defers network changes and queued calls until the foreground", async () => {
      const transport = setup()
      handshake(["heartbeat", "call-keys"])
      transport.setForeground(false)
      transport.networkChanged()
      const send = track(transport.call("threads.send", { prompt: "hi" }))
      transport.networkChanged()
      transport.reconnectNow()
      await vi.advanceTimersByTimeAsync(30_000)
      expect(sockets).toHaveLength(1)
      expect(send.error).toBeUndefined()
      transport.setForeground(true)
      expect(sockets).toHaveLength(2)
      handshake(["heartbeat", "call-keys"])
      expect(latest().calls()).toEqual([
        { type: "call", id: 1, method: "threads.send", payload: { prompt: "hi" }, key: "key-1" },
      ])
      latest().result(1)
      await vi.advanceTimersByTimeAsync(0)
      expect(send.value).toEqual({ result: null })
    })

    it("still expires an offline call while background retries are paused", async () => {
      const transport = setup()
      handshake(["heartbeat", "call-keys"])
      const send = track(transport.call("threads.send", { prompt: "hi" }))
      transport.setForeground(false)
      latest().drop()
      await vi.advanceTimersByTimeAsync(60_000)
      expect(send.error).toMatchObject({ tag: "Timeout", message: MESSAGES.mayHaveRun })
      expect(sockets).toHaveLength(1)
    })

    it("ignores a handshake from a connection canceled when the app left", () => {
      const transport = setup()
      transport.setForeground(false)
      handshake(["heartbeat"])
      expect(ready).toBe(0)
      expect(statuses.at(-1)).toBe("offline")
    })
  })

  describe("watched threads", () => {
    const watchFrames = () => latest().sent.filter((frame) => frame.type === "watch")

    it("tells a desktop that offers it which transcripts to send, again after each handshake", () => {
      const transport = setup()
      handshake(["heartbeat", "watch"])
      expect(watchFrames()).toEqual([{ type: "watch", threadIds: [] }])
      transport.setWatching(["t1"])
      expect(watchFrames().at(-1)).toEqual({ type: "watch", threadIds: ["t1"] })
      transport.networkChanged()
      handshake(["heartbeat", "watch"])
      expect(watchFrames()).toEqual([{ type: "watch", threadIds: ["t1"] }])
    })

    it("sends nothing new to a desktop without it", () => {
      const transport = setup()
      handshake(["heartbeat"])
      transport.setWatching(["t1"])
      expect(watchFrames()).toEqual([])
    })

    it("never narrows the transcripts when not compact, even to a desktop that offers it", () => {
      const transport = setup(undefined, { compact: false })
      handshake(["heartbeat", "watch"])
      transport.setWatching(["t1"])
      transport.networkChanged()
      handshake(["heartbeat", "watch"])
      transport.setWatching(["t2"])
      expect(sockets.flatMap((socket) => socket.sent).filter((frame) => frame.type === "watch")).toEqual([])
    })
  })

  describe("immediate reconnect", () => {
    it("replaces a socket that looks open when the network changes", () => {
      const transport = setup()
      handshake()
      transport.networkChanged()
      expect(sockets[0]!.closed).toBe(true)
      expect(sockets).toHaveLength(2)
      expect(statuses.at(-1)).toBe("connecting")
    })

    it("skips the backoff when the network changes while offline", async () => {
      const transport = setup()
      for (let i = 0; i < 5; i++) {
        latest().drop()
        await vi.advanceTimersByTimeAsync(10_000)
      }
      latest().drop()
      const before = sockets.length
      transport.networkChanged()
      expect(sockets).toHaveLength(before + 1)
    })

    it("skips the backoff when the app returns to the foreground offline", () => {
      const transport = setup()
      transport.setForeground(false)
      latest().drop()
      transport.setForeground(true)
      expect(sockets).toHaveLength(2)
    })

    it("sends queued calls once over the new socket", async () => {
      const transport = setup()
      handshake()
      const send = track(transport.call("threads.send", {}))
      transport.networkChanged()
      handshake()
      expect(sockets[0]!.calls()).toHaveLength(1)
      expect(latest().calls()).toEqual([{ type: "call", id: 1, method: "threads.send", payload: {}, key: "key-1" }])
      latest().result(1)
      await vi.advanceTimersByTimeAsync(0)
      expect(send.value).toEqual({ result: null })
    })
  })

  describe("an older desktop without features", () => {
    it("sends no pings or keys and never closes an idle link", async () => {
      const transport = setup()
      handshake([])
      void transport.call("threads.list", undefined)
      await vi.advanceTimersByTimeAsync(5 * 60_000)
      expect(latest().pings()).toEqual([])
      expect(latest().closed).toBe(false)

      transport.setForeground(false)
      transport.setForeground(true)
      expect(latest().pings()).toEqual([])
    })

    it("omits the key on a mutation and fails it on a drop instead of sending it twice", async () => {
      const transport = setup()
      handshake([])
      const send = track(transport.call("threads.send", { prompt: "hi" }))
      const read = track(transport.call("threads.list", undefined))
      expect(latest().calls()).toEqual([
        { type: "call", id: 1, method: "threads.send", payload: { prompt: "hi" } },
        { type: "call", id: 2, method: "threads.list" },
      ])

      latest().drop()
      await vi.advanceTimersByTimeAsync(0)
      expect(send.error).toMatchObject({ tag: "Offline", message: MESSAGES.lostReply })

      await vi.advanceTimersByTimeAsync(500)
      handshake([])
      expect(latest().calls()).toEqual([{ type: "call", id: 2, method: "threads.list" }])
      latest().result(2, [])
      await vi.advanceTimersByTimeAsync(0)
      expect(read.value).toEqual({ result: [] })
    })

    it("still sends a mutation queued before it reached the old desktop", async () => {
      const transport = setup()
      const send = track(transport.call("threads.send", {}))
      latest().drop()
      await vi.advanceTimersByTimeAsync(500)
      handshake([])
      expect(latest().calls()).toEqual([{ type: "call", id: 1, method: "threads.send", payload: {} }])
      latest().result(1)
      await vi.advanceTimersByTimeAsync(0)
      expect(send.value).toEqual({ result: null })
    })

    it("refuses a different protocol version without retrying", async () => {
      const transport = setup()
      const read = track(transport.call("threads.list", undefined))
      latest().open()
      latest().answer()
      latest().ready([], 3)
      await vi.advanceTimersByTimeAsync(60_000)
      expect(statuses.at(-1)).toBe("unauthorized")
      expect(sockets).toHaveLength(1)
      expect(read.error).toMatchObject({ tag: "Unauthorized", message: "protocol 3 vs 2" })
    })
  })

  describe("racing the dial plan", () => {
    const TAILSCALE = "ws://100.64.0.2:47821/remote"
    const LAN = "ws://192.168.1.5:47821/remote"
    const RELAY = "wss://mac.example.com/remote"

    async function connectOverRelay() {
      const transport = setup([direct(LAN), relay(RELAY)])
      await vi.advanceTimersByTimeAsync(RELAY_DELAY_MS)
      socketAt(RELAY).open()
      socketAt(RELAY).answer()
      socketAt(RELAY).ready(["call-keys"])
      return transport
    }

    it("dials every direct address at once and the relay after its delay", async () => {
      setup([direct(TAILSCALE), direct(LAN), relay(RELAY)])
      expect(urls()).toEqual([TAILSCALE, LAN])
      await vi.advanceTimersByTimeAsync(RELAY_DELAY_MS - 1)
      expect(urls()).toEqual([TAILSCALE, LAN])
      await vi.advanceTimersByTimeAsync(1)
      expect(urls()).toEqual([TAILSCALE, LAN, RELAY])
    })

    it("dials the LAN, then Tailscale, then the relay", async () => {
      setup(dialPlan({ hosts: ["100.64.0.2", "192.168.1.5"], port: 47821, relay: "mac.example.com" }))
      expect(urls()).toEqual([LAN])
      await vi.advanceTimersByTimeAsync(TAILSCALE_DELAY_MS)
      expect(urls()).toEqual([LAN, TAILSCALE])
      await vi.advanceTimersByTimeAsync(RELAY_DELAY_MS - TAILSCALE_DELAY_MS)
      expect(urls()).toEqual([LAN, TAILSCALE, RELAY])
    })

    it("still dials the LAN first when a direct check moves the link off the relay", async () => {
      setup(dialPlan({ hosts: ["100.64.0.2", "192.168.1.5"], port: 47821, relay: "mac.example.com" }))
      await vi.advanceTimersByTimeAsync(RELAY_DELAY_MS)
      socketAt(RELAY).open()
      socketAt(RELAY).answer()
      socketAt(RELAY).ready(["call-keys"])
      await vi.advanceTimersByTimeAsync(DIRECT_CHECK_INTERVAL_MS)
      const dialedBefore = sockets.length
      socketAt(LAN).open()
      const directRound = () => urls().slice(dialedBefore)
      expect(directRound()).toEqual([LAN])
      await vi.advanceTimersByTimeAsync(TAILSCALE_DELAY_MS)
      expect(directRound()).toEqual([LAN, TAILSCALE])
    })

    it("answers only the first socket that opens and closes the rest unused", async () => {
      setup([direct(TAILSCALE), direct(LAN), relay(RELAY)])
      await vi.advanceTimersByTimeAsync(RELAY_DELAY_MS)
      socketAt(LAN).open()
      socketAt(RELAY).open()
      socketAt(TAILSCALE).open()
      socketAt(LAN).answer()
      expect(socketAt(LAN).sent).toEqual([{ type: "hello", name: "Pixel", compactEvents: true }])
      for (const url of [TAILSCALE, RELAY]) {
        expect(socketAt(url).closed).toBe(true)
        expect(socketAt(url).raw).toEqual([])
      }
      socketAt(LAN).ready()
      expect(statuses.at(-1)).toBe("connected")
    })

    it("falls back to the relay when no direct address opens", async () => {
      setup([direct(LAN), relay(RELAY)])
      await vi.advanceTimersByTimeAsync(RELAY_DELAY_MS)
      socketAt(RELAY).open()
      socketAt(RELAY).answer()
      expect(socketAt(LAN).closed).toBe(true)
      expect(socketAt(LAN).raw).toEqual([])
      expect(socketAt(RELAY).sent).toEqual([{ type: "hello", name: "Pixel", compactEvents: true }])
    })

    it("waits for the relay when a direct address closes first", async () => {
      setup([direct(LAN), relay(RELAY)])
      socketAt(LAN).drop()
      expect(statuses.at(-1)).toBe("connecting")
      await vi.advanceTimersByTimeAsync(RELAY_DELAY_MS)
      socketAt(RELAY).open()
      socketAt(RELAY).answer()
      socketAt(RELAY).ready()
      expect(statuses.at(-1)).toBe("connected")
    })

    it("loses the link when nothing opens within the connect timeout, then backs off", async () => {
      setup([direct(LAN), relay(RELAY)])
      await vi.advanceTimersByTimeAsync(10_000)
      expect(sockets.every((socket) => socket.closed)).toBe(true)
      expect(statuses.at(-1)).toBe("offline")
      await vi.advanceTimersByTimeAsync(499)
      expect(sockets).toHaveLength(2)
      await vi.advanceTimersByTimeAsync(1)
      expect(urls()).toEqual([LAN, RELAY, LAN])
    })

    it("loses the link at once when every socket closed", async () => {
      setup([direct(LAN), relay(RELAY)])
      await vi.advanceTimersByTimeAsync(RELAY_DELAY_MS)
      socketAt(LAN).drop()
      socketAt(RELAY).drop()
      expect(statuses.at(-1)).toBe("offline")
    })

    it("stops on a failed handshake instead of trying the other addresses when there is no relay", async () => {
      setup([direct(TAILSCALE), direct(LAN)])
      socketAt(TAILSCALE).open()
      socketAt(TAILSCALE).drop(CLOSE_HANDSHAKE_FAILED)
      await vi.advanceTimersByTimeAsync(60_000)
      expect(urls()).toEqual([TAILSCALE, LAN])
      expect(statuses.at(-1)).toBe("unauthorized")
    })

    it("moves from the relay to a direct address once one answers, keeping pending calls", async () => {
      const transport = await connectOverRelay()
      const read = track(transport.call("threads.list", undefined))
      const before = sockets.length
      await vi.advanceTimersByTimeAsync(DIRECT_CHECK_INTERVAL_MS - 1)
      expect(sockets).toHaveLength(before)
      await vi.advanceTimersByTimeAsync(1)
      const check = latest()
      expect(check.url).toBe(LAN)

      check.open()
      expect(check.closed).toBe(true)
      expect(check.raw).toEqual([])
      expect(socketAt(RELAY).closed).toBe(true)
      expect(latest()).not.toBe(check)
      expect(latest().url).toBe(LAN)

      handshake(["call-keys"])
      expect(latest().calls()).toEqual([{ type: "call", id: 1, method: "threads.list" }])
      latest().result(1, [])
      await vi.advanceTimersByTimeAsync(0)
      expect(read.value).toEqual({ result: [] })
    })

    it("stays on the relay when no direct address answers the check", async () => {
      await connectOverRelay()
      const relaySocket = socketAt(RELAY)
      await vi.advanceTimersByTimeAsync(DIRECT_CHECK_INTERVAL_MS + DIRECT_CHECK_TIMEOUT_MS)
      expect(latest().url).toBe(LAN)
      expect(latest().closed).toBe(true)
      expect(relaySocket.closed).toBe(false)
      expect(statuses.at(-1)).toBe("connected")

      await vi.advanceTimersByTimeAsync(DIRECT_CHECK_INTERVAL_MS - DIRECT_CHECK_TIMEOUT_MS)
      expect(sockets.filter((socket) => socket.url === LAN)).toHaveLength(3)
    })

    it("checks no direct address while connected directly", async () => {
      setup([direct(LAN), relay(RELAY)])
      handshake(["call-keys"])
      await vi.advanceTimersByTimeAsync(3 * DIRECT_CHECK_INTERVAL_MS)
      expect(urls()).toEqual([LAN])
    })

    it("closes the relay in the background and races direct addresses on return", async () => {
      const transport = await connectOverRelay()
      const relaySocket = socketAt(RELAY)
      const before = sockets.length
      transport.setForeground(false)
      await vi.advanceTimersByTimeAsync(5 * DIRECT_CHECK_INTERVAL_MS)
      expect(sockets).toHaveLength(before)
      expect(relaySocket.closed).toBe(true)

      transport.setForeground(true)
      expect(sockets).toHaveLength(before + 1)
      expect(latest().url).toBe(LAN)
    })

    it("re-races from the direct addresses when the network changes", async () => {
      const transport = await connectOverRelay()
      transport.networkChanged()
      expect(socketAt(RELAY).closed).toBe(true)
      expect(latest().url).toBe(LAN)
      latest().open()
      latest().answer()
      expect(latest().hello()).toEqual({ type: "hello", name: "Pixel", compactEvents: true })
    })

    it("races the relay alone when a direct address fails the handshake, until the network changes", async () => {
      const transport = setup([direct(LAN), relay(RELAY)])
      socketAt(LAN).open()
      socketAt(LAN).drop(CLOSE_HANDSHAKE_FAILED)
      expect(urls()).toEqual([LAN, RELAY])
      handshake(["call-keys"])
      expect(statuses).not.toContain("unauthorized")
      expect(statuses.at(-1)).toBe("connected")

      await vi.advanceTimersByTimeAsync(3 * DIRECT_CHECK_INTERVAL_MS)
      expect(urls()).toEqual([LAN, RELAY])

      transport.networkChanged()
      expect(urls()).toEqual([LAN, RELAY, LAN])
    })

    it("races the relay alone when a direct address drops before ready after the network changes", async () => {
      const transport = await connectOverRelay()
      transport.networkChanged()
      latest().open()
      latest().drop()
      expect(urls()).toEqual([LAN, RELAY, LAN, RELAY])
      handshake(["call-keys"])
      expect(statuses.at(-1)).toBe("connected")
    })

    it("races the relay alone when a direct address never says ready", async () => {
      setup([direct(LAN), relay(RELAY)])
      socketAt(LAN).open()
      socketAt(LAN).answer()
      await vi.advanceTimersByTimeAsync(CONNECT_TIMEOUT_MS)
      expect(socketAt(LAN).closed).toBe(true)
      expect(urls()).toEqual([LAN, RELAY])
      handshake(["call-keys"])
      expect(statuses.at(-1)).toBe("connected")
    })

    it("stops with the refused message when the relay fails the handshake", async () => {
      setup([direct(LAN), relay(RELAY)])
      await vi.advanceTimersByTimeAsync(RELAY_DELAY_MS)
      socketAt(RELAY).open()
      socketAt(RELAY).drop(CLOSE_HANDSHAKE_FAILED)
      await vi.advanceTimersByTimeAsync(60_000)
      expect(urls()).toEqual([LAN, RELAY])
      expect(statuses.at(-1)).toBe("unauthorized")
      expect(refusals.at(-1)).toBe("refused")
      expect(errors.at(-1)).toBe("refusal refused")
    })

    it("dials only the direct addresses in the round after a direct check answers", async () => {
      await connectOverRelay()
      await vi.advanceTimersByTimeAsync(DIRECT_CHECK_INTERVAL_MS)
      latest().open()
      await vi.advanceTimersByTimeAsync(CONNECT_TIMEOUT_MS - 1)
      expect(urls()).toEqual([LAN, RELAY, LAN, LAN])
    })

    it("races both routes at once when no direct address opens in the direct round", async () => {
      await connectOverRelay()
      await vi.advanceTimersByTimeAsync(DIRECT_CHECK_INTERVAL_MS)
      latest().open()
      await vi.advanceTimersByTimeAsync(CONNECT_TIMEOUT_MS)
      expect(urls()).toEqual([LAN, RELAY, LAN, LAN, LAN])
      await vi.advanceTimersByTimeAsync(RELAY_DELAY_MS)
      expect(urls()).toEqual([LAN, RELAY, LAN, LAN, LAN, RELAY])
    })

    it("keeps the open socket when the dials change and uses them from the next round", async () => {
      const transport = setup([direct(LAN)])
      handshake(["call-keys"])
      const first = latest()
      transport.setDials([direct(TAILSCALE), relay(RELAY)])
      expect(first.closed).toBe(false)
      void transport.call("threads.list", undefined)
      expect(first.calls()).toHaveLength(1)

      first.drop()
      await vi.advanceTimersByTimeAsync(500)
      expect(latest().url).toBe(TAILSCALE)
      await vi.advanceTimersByTimeAsync(RELAY_DELAY_MS)
      expect(latest().url).toBe(RELAY)
    })
  })

  describe("the pinned host key", () => {
    const LAN = "ws://192.168.1.5:47821/remote"
    const RELAY = "wss://mac.example.com/remote"

    it("never dials a pairing that has no key", async () => {
      const transport = setup([direct(LAN), relay(RELAY)], { hostKey: null })
      transport.networkChanged()
      transport.reconnectNow()
      await vi.advanceTimersByTimeAsync(60_000)
      expect(sockets).toEqual([])
      expect(statuses).toEqual(["unauthorized"])
      expect(refusals).toEqual(["predates"])
      expect(errors).toEqual(["refusal predates"])
    })

    it("races the relay alone when a direct address answers with another key", () => {
      const transport = setup([direct(LAN), relay(RELAY)])
      const read = track(transport.call("threads.list", undefined))
      socketAt(LAN).open()
      socketAt(LAN).impersonate()
      expect(socketAt(LAN).closed).toBe(true)
      expect(socketAt(LAN).sent).toEqual([])
      expect(urls()).toEqual([LAN, RELAY])
      expect(statuses).not.toContain("unauthorized")

      handshake()
      expect(statuses.at(-1)).toBe("connected")
      expect(read).toEqual({})
    })

    it("stops with the refused message when the relay answers with another key", () => {
      setup([direct(LAN), relay(RELAY)])
      vi.advanceTimersByTime(RELAY_DELAY_MS)
      socketAt(RELAY).open()
      socketAt(RELAY).impersonate()
      expect(socketAt(RELAY).closed).toBe(true)
      expect(socketAt(RELAY).sent).toEqual([])
      expect(statuses.at(-1)).toBe("unauthorized")
      expect(refusals.at(-1)).toBe("refused")
    })

    it("handles a close after the handshake by its code, never as a stranger at the address", async () => {
      setup([direct(LAN), relay(RELAY)])
      socketAt(LAN).open()
      socketAt(LAN).answer()
      socketAt(LAN).drop()
      expect(statuses.at(-1)).toBe("offline")
      await vi.advanceTimersByTimeAsync(500)
      expect(urls()).toEqual([LAN, LAN])
    })

    it("closes and redials when a frame fails to decrypt", async () => {
      setup()
      handshake()
      latest().onmessage?.({ data: new Uint8Array(64).buffer })
      expect(latest().closed).toBe(true)
      expect(statuses.at(-1)).toBe("offline")
      await vi.advanceTimersByTimeAsync(500)
      expect(sockets).toHaveLength(2)
    })

    it("sends the pairing secret until a ready uses it up", async () => {
      setup(undefined, { secret: SECRET })
      latest().open()
      latest().answer()
      expect(latest().hello()).toEqual({ type: "hello", name: "Pixel", secret: SECRET, compactEvents: true })
      latest().drop()
      await vi.advanceTimersByTimeAsync(500)
      handshake()
      expect(sockets[1]!.hello()).toMatchObject({ secret: SECRET })
      expect(secretUsed).toBe(1)

      latest().drop()
      await vi.advanceTimersByTimeAsync(500)
      latest().open()
      latest().answer()
      expect(latest().hello()).toEqual({ type: "hello", name: "Pixel", compactEvents: true })
    })
  })

  describe("approval", () => {
    it("shows the code both sides derive and keeps waiting past the connect timeout", async () => {
      const transport = awaitCode()
      expect(statuses.at(-1)).toBe("approval")
      expect(approvals).toEqual([{ code: latest().code(), accepted: false }])
      await vi.advanceTimersByTimeAsync(4 * 60_000)
      expect(latest().closed).toBe(false)
      expect(sockets).toHaveLength(1)

      const read = track(transport.call("threads.list", undefined))
      expect(latest().calls()).toEqual([])
      latest().ready()
      expect(statuses.at(-1)).toBe("connected")
      expect(approvals.at(-1)).toBeNull()
      expect(latest().calls()).toEqual([{ type: "call", id: 1, method: "threads.list" }])
      expect(read).toEqual({})
    })

    it("passes on no event or result before the developer answers Yes", async () => {
      const transport = awaitCode({ verified: false })
      const read = track(transport.call("threads.list", undefined))
      latest().receive({ type: "event", event: { type: "thread.removed", id: "t1" } })
      latest().ready()
      latest().receive({ type: "event", event: { type: "thread.removed", id: "t1" } })
      latest().result(1, ["forged"])
      await vi.advanceTimersByTimeAsync(0)
      expect(received).toBe(0)
      expect(read).toEqual({})

      transport.confirmHost(true)
      latest().receive({ type: "event", event: { type: "thread.removed", id: "t1" } })
      expect(received).toBe(1)
    })

    it("asks to verify an unverified key, and sends calls only after the developer answers Yes", async () => {
      const transport = awaitCode({ verified: false })
      expect(latest().hello()).toMatchObject({ verify: true })
      const read = track(transport.call("threads.list", undefined))
      latest().ready()
      expect(statuses.at(-1)).toBe("approval")
      expect(approvals.at(-1)).toEqual({ code: latest().code(), accepted: true })
      expect(latest().calls()).toEqual([])
      expect(ready).toBe(0)

      transport.confirmHost(true)
      expect(verified).toBe(1)
      expect(statuses.at(-1)).toBe("connected")
      expect(approvals.at(-1)).toBeNull()
      expect(latest().calls()).toEqual([{ type: "call", id: 1, method: "threads.list" }])
      latest().result(1, [])
      await vi.advanceTimersByTimeAsync(0)
      expect(read.value).toEqual({ result: [] })

      latest().drop()
      await vi.advanceTimersByTimeAsync(500)
      latest().open()
      latest().answer()
      expect(latest().hello()).not.toHaveProperty("verify")
    })

    it("closes and stops as refused when the developer answers No", async () => {
      const transport = awaitCode({ verified: false })
      latest().ready()
      transport.confirmHost(false)
      await vi.advanceTimersByTimeAsync(60_000)
      expect(latest().closed).toBe(true)
      expect(sockets).toHaveLength(1)
      expect(verified).toBe(0)
      expect(statuses.at(-1)).toBe("unauthorized")
      expect(refusals.at(-1)).toBe("refused")
    })

    it("refuses an unverified key the machine admits without showing a code", () => {
      setup(undefined, { verified: false })
      latest().open()
      latest().answer()
      latest().ready()
      expect(statuses.at(-1)).toBe("unauthorized")
      expect(refusals.at(-1)).toBe("refused")
    })

    it("stops as refused when the machine reveals a nonce it did not commit to", () => {
      setup([direct("ws://192.168.1.5:47821/remote"), relay("wss://mac.example.com/remote")])
      latest().open()
      latest().answer()
      latest().pend()
      latest().reveal(newNonce())
      expect(approvals).toEqual([])
      expect(statuses.at(-1)).toBe("unauthorized")
      expect(refusals.at(-1)).toBe("refused")
      expect(sockets).toHaveLength(1)
    })

    it("forgets the code when the link drops", async () => {
      awaitCode()
      latest().drop()
      expect(approvals.at(-1)).toBeNull()
      expect(statuses.at(-1)).toBe("offline")
    })

    it("stops as refused when the machine closes a request nobody approved", () => {
      setup()
      latest().open()
      latest().answer()
      latest().pend()
      latest().drop(CLOSE_UNAUTHORIZED)
      expect(statuses.at(-1)).toBe("unauthorized")
      expect(refusals.at(-1)).toBe("refused")
    })
  })

  it("stop fails pending calls and never reconnects", async () => {
    const transport = setup()
    handshake()
    const send = track(transport.call("threads.send", {}))
    transport.stop()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(send.error).toMatchObject({ tag: "Offline" })
    expect(sockets).toHaveLength(1)
    expect(latest().closed).toBe(true)
  })
})

describe("transcript pages", () => {
  it("arrive over 3G well inside the silence limit, which no frame can outlast", () => {
    const threeGBytesPerMs = 400_000 / 8 / 1000
    expect(TRANSCRIPT_PAGE_BYTES / threeGBytesPerMs).toBeLessThan(IDLE_TIMEOUT_MS / 10)
  })
})
