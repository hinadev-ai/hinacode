import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { TRANSCRIPT_PAGE_BYTES } from "@shared/compactTranscript.ts"
import { clientProof, serverProof } from "@shared/proof.ts"
import {
  CHALLENGE_WAIT_MS,
  DIRECT_CHECK_INTERVAL_MS,
  DIRECT_CHECK_TIMEOUT_MS,
  type Dial,
  RELAY_DELAY_MS,
} from "@shared/remote.ts"
import {
  CLOSE_TOKEN_ROTATED,
  CLOSE_UNAUTHORIZED,
  CONNECT_TIMEOUT_MS,
  LOST_REPLY_MESSAGE,
  MAY_HAVE_RUN_MESSAGE,
  NOT_SENT_MESSAGE,
  type SocketLike,
  Transport,
  type TransportStatus,
  IDLE_TIMEOUT_MS,
} from "./transport"

const TOKEN = "secret"

/** A socket and the server behind it, which holds `TOKEN`. */
class FakeSocket implements SocketLike {
  onopen: (() => void) | null = null
  onmessage: ((message: { data: unknown }) => void) | null = null
  onclose: ((event: { code: number }) => void) | null = null
  readonly sent: Record<string, unknown>[] = []
  closed = false
  serverNonce: string | undefined

  constructor(readonly url: string) {}

  send(data: string) {
    this.sent.push(JSON.parse(data))
  }
  close() {
    this.closed = true
  }

  open() {
    this.onopen?.()
  }
  challenge(nonce = "server-nonce") {
    this.serverNonce = nonce
    this.receive({ type: "challenge", nonce })
  }
  /** Proves `TOKEN` back when the client proved it, as a current server does; an older one omits the proof. */
  ready(features: readonly string[] = ["heartbeat", "call-keys", "terminal-attach"], version = 1) {
    const auth = this.sent.find((frame) => frame.type === "auth")
    const proof =
      typeof auth?.nonce === "string" && this.serverNonce !== undefined
        ? { proof: serverProof(TOKEN, auth.nonce, this.serverNonce) }
        : {}
    this.receive({ type: "ready", version, features, ...proof })
  }
  receive(frame: unknown) {
    this.onmessage?.({ data: JSON.stringify(frame) })
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
let ready: number
let keys: number
let plan: readonly Dial[] = []

const direct = (url: string): Dial => ({ url, route: "direct", delayMs: 0 })
const relay = (url: string): Dial => ({ url, route: "relay", delayMs: RELAY_DELAY_MS })

function setup(dials: readonly [Dial, ...Dial[]] = [direct("ws://desktop/remote")]) {
  sockets = []
  statuses = []
  ready = 0
  keys = 0
  plan = dials
  const transport = new Transport({
    dials,
    token: TOKEN,
    isMutation: (method) => MUTATIONS.has(method),
    onStatus: (status) => statuses.push(status),
    onReady: () => ready++,
    onEvent: () => {},
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

function handshake(features?: readonly string[]) {
  latest().open()
  latest().challenge()
  latest().ready(features)
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
  plan = []
})
afterEach(() => {
  vi.useRealTimers()
  // Away from home a direct address may be a stranger's HinaCode, so only a pairing without a relay ever sends it
  // the token.
  if (!plan.some((dial) => dial.route === "relay")) return
  const directUrls = new Set(plan.filter((dial) => dial.route === "direct").map((dial) => dial.url))
  for (const socket of sockets.filter((socket) => directUrls.has(socket.url)))
    expect(JSON.stringify(socket.sent)).not.toContain(TOKEN)
})

describe("Transport", () => {
  it("requests compact events with its proof and connects on a ready that proves the token back", () => {
    setup()
    expect(statuses).toEqual(["connecting"])
    latest().open()
    expect(latest().sent).toEqual([])
    latest().challenge("server-nonce")
    const [auth] = latest().sent
    expect(auth).toEqual({ type: "auth", nonce: expect.any(String), proof: expect.any(String), compactEvents: true })
    expect(auth!.proof).toBe(clientProof(TOKEN, "server-nonce", auth!.nonce as string))
    expect(JSON.stringify(latest().sent)).not.toContain(TOKEN)
    expect(statuses.at(-1)).toBe("connecting")
    latest().ready()
    expect(statuses.at(-1)).toBe("connected")
    expect(ready).toBe(1)
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
    expect(latest().calls().map((frame) => frame.key)).toEqual(["key-1", undefined, "key-2"])

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
      expect(send.error).toMatchObject({ tag: "Timeout", message: MAY_HAVE_RUN_MESSAGE })
    })

    it("says not sent when the call never left the phone", async () => {
      const transport = setup()
      const send = track(transport.call("threads.send", {}))
      await vi.advanceTimersByTimeAsync(60_000)
      expect(send.error).toMatchObject({ tag: "Timeout", message: NOT_SENT_MESSAGE })
    })

    it("expires a call on ready when the clock jumped past the limit before its timer ran", async () => {
      const transport = setup()
      const send = track(transport.call("threads.send", {}))
      const read = track(transport.call("threads.list", undefined))
      vi.setSystemTime(Date.now() + 61_000)
      handshake()
      await vi.advanceTimersByTimeAsync(0)
      expect(latest().calls()).toEqual([])
      expect(send.error).toMatchObject({ tag: "Timeout", message: NOT_SENT_MESSAGE })
      expect(read.error).toMatchObject({ tag: "Timeout", message: NOT_SENT_MESSAGE })
    })

    it("counts earlier outages when a late ready arrives", async () => {
      const transport = setup()
      handshake()
      const send = track(transport.call("threads.send", {}))
      latest().drop()
      await vi.advanceTimersByTimeAsync(400)
      vi.setSystemTime(Date.now() + 30_000)
      await vi.advanceTimersByTimeAsync(100)
      handshake()
      expect(latest().calls()).toHaveLength(1)

      latest().drop()
      await vi.advanceTimersByTimeAsync(400)
      vi.setSystemTime(Date.now() + 29_600)
      await vi.advanceTimersByTimeAsync(100)
      const before = latest().calls().length
      handshake()
      await vi.advanceTimersByTimeAsync(0)
      expect(latest().calls()).toHaveLength(before)
      expect(send.error).toMatchObject({ tag: "Timeout", message: MAY_HAVE_RUN_MESSAGE })
    })

    it("still sends a call whose outage stayed under the limit", async () => {
      const transport = setup()
      const send = track(transport.call("threads.send", {}))
      vi.setSystemTime(Date.now() + 59_000)
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
        token: "secret",
        isMutation: () => false,
        onStatus: () => {},
        onReady: () => {},
        onEvent: () => {},
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

    it.each([CLOSE_UNAUTHORIZED, CLOSE_TOKEN_ROTATED])("stops after close code %i and fails pending calls", async (code) => {
      const transport = setup()
      const send = track(transport.call("threads.send", {}))
      latest().open()
      latest().challenge()
      latest().drop(code)
      await vi.advanceTimersByTimeAsync(60_000)
      expect(sockets).toHaveLength(1)
      expect(statuses.at(-1)).toBe("unauthorized")
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

    it("pauses in the background and probes for 5 s on return", async () => {
      const transport = setup()
      handshake()
      transport.setForeground(false)
      await vi.advanceTimersByTimeAsync(120_000)
      expect(latest().closed).toBe(false)
      expect(latest().pings()).toHaveLength(0)

      transport.setForeground(true)
      expect(latest().pings()).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(4_999)
      expect(latest().closed).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      expect(latest().closed).toBe(true)
    })

    it("keeps a socket whose probe is answered", async () => {
      const transport = setup()
      handshake()
      transport.setForeground(false)
      transport.setForeground(true)
      latest().receive({ type: "pong", at: 0 })
      await vi.advanceTimersByTimeAsync(10_000)
      expect(latest().closed).toBe(false)
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
      expect(send.error).toMatchObject({ tag: "Offline", message: LOST_REPLY_MESSAGE })

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
      latest().challenge()
      latest().ready([], 2)
      await vi.advanceTimersByTimeAsync(60_000)
      expect(statuses.at(-1)).toBe("unauthorized")
      expect(sockets).toHaveLength(1)
      expect(read.error).toMatchObject({ tag: "Unauthorized" })
    })
  })

  describe("racing the dial plan", () => {
    const TAILSCALE = "ws://100.64.0.2:47821/remote"
    const LAN = "ws://192.168.1.5:47821/remote"
    const RELAY = "wss://mac.example.com/remote"
    const socketAt = (url: string) => sockets.findLast((socket) => socket.url === url)!
    const urls = () => sockets.map((socket) => socket.url)

    async function connectOverRelay() {
      const transport = setup([direct(LAN), relay(RELAY)])
      await vi.advanceTimersByTimeAsync(RELAY_DELAY_MS)
      socketAt(RELAY).open()
      socketAt(RELAY).challenge()
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

    it("answers only the first socket that opens and closes the rest unused", async () => {
      setup([direct(TAILSCALE), direct(LAN), relay(RELAY)])
      await vi.advanceTimersByTimeAsync(RELAY_DELAY_MS)
      socketAt(LAN).open()
      socketAt(RELAY).open()
      socketAt(TAILSCALE).open()
      socketAt(LAN).challenge()
      expect(socketAt(LAN).sent).toEqual([
        { type: "auth", nonce: expect.any(String), proof: expect.any(String), compactEvents: true },
      ])
      for (const url of [TAILSCALE, RELAY]) {
        expect(socketAt(url).closed).toBe(true)
        expect(socketAt(url).sent).toEqual([])
      }
      socketAt(LAN).ready()
      expect(statuses.at(-1)).toBe("connected")
    })

    it("falls back to the relay when no direct address opens", async () => {
      setup([direct(LAN), relay(RELAY)])
      await vi.advanceTimersByTimeAsync(RELAY_DELAY_MS)
      socketAt(RELAY).open()
      socketAt(RELAY).challenge()
      expect(socketAt(LAN).closed).toBe(true)
      expect(socketAt(LAN).sent).toEqual([])
      expect(socketAt(RELAY).sent).toEqual([
        { type: "auth", nonce: expect.any(String), proof: expect.any(String), compactEvents: true },
      ])
    })

    it("waits for the relay when a direct address closes first", async () => {
      setup([direct(LAN), relay(RELAY)])
      socketAt(LAN).drop()
      expect(statuses.at(-1)).toBe("connecting")
      await vi.advanceTimersByTimeAsync(RELAY_DELAY_MS)
      socketAt(RELAY).open()
      socketAt(RELAY).challenge()
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

    it("stops on a refused token instead of trying the other addresses", async () => {
      setup([direct(TAILSCALE), direct(LAN)])
      socketAt(TAILSCALE).open()
      socketAt(TAILSCALE).challenge()
      socketAt(TAILSCALE).drop(CLOSE_UNAUTHORIZED)
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
      expect(check.sent).toEqual([])
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

    it("checks nothing in the background and checks at once on return", async () => {
      const transport = await connectOverRelay()
      const before = sockets.length
      transport.setForeground(false)
      await vi.advanceTimersByTimeAsync(5 * DIRECT_CHECK_INTERVAL_MS)
      expect(sockets).toHaveLength(before)

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
      latest().challenge()
      expect(latest().sent).toEqual([
        { type: "auth", nonce: expect.any(String), proof: expect.any(String), compactEvents: true },
      ])
    })

    it("races the relay alone when a direct address refuses the token, until the network changes", async () => {
      const transport = setup([direct(LAN), relay(RELAY)])
      socketAt(LAN).open()
      socketAt(LAN).challenge()
      socketAt(LAN).drop(CLOSE_UNAUTHORIZED)
      expect(urls()).toEqual([LAN, RELAY])
      handshake(["call-keys"])
      expect(statuses).not.toContain("unauthorized")
      expect(statuses.at(-1)).toBe("connected")

      await vi.advanceTimersByTimeAsync(3 * DIRECT_CHECK_INTERVAL_MS)
      expect(urls()).toEqual([LAN, RELAY])

      transport.networkChanged()
      expect(urls()).toEqual([LAN, RELAY, LAN])
    })

    it("stops when the relay refuses the token", async () => {
      setup([direct(LAN), relay(RELAY)])
      await vi.advanceTimersByTimeAsync(RELAY_DELAY_MS)
      socketAt(RELAY).open()
      socketAt(RELAY).challenge()
      socketAt(RELAY).drop(CLOSE_UNAUTHORIZED)
      await vi.advanceTimersByTimeAsync(60_000)
      expect(urls()).toEqual([LAN, RELAY])
      expect(statuses.at(-1)).toBe("unauthorized")
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

  describe("proving the token", () => {
    const LAN = "ws://192.168.1.5:47821/remote"
    const RELAY = "wss://mac.example.com/remote"
    const socketAt = (url: string) => sockets.findLast((socket) => socket.url === url)!
    const urls = () => sockets.map((socket) => socket.url)

    it.each([
      ["a wrong proof", (socket: FakeSocket) => socket.receive({ type: "ready", version: 1, proof: "00" })],
      ["no proof", (socket: FakeSocket) => socket.receive({ type: "ready", version: 1 })],
    ])("races the relay alone when a direct ready carries %s", (_, answer) => {
      const transport = setup([direct(LAN), relay(RELAY)])
      const read = track(transport.call("threads.list", undefined))
      socketAt(LAN).open()
      socketAt(LAN).challenge()
      answer(socketAt(LAN))
      expect(socketAt(LAN).closed).toBe(true)
      expect(socketAt(LAN).calls()).toEqual([])
      expect(urls()).toEqual([LAN, RELAY])
      expect(statuses).not.toContain("connected")
      expect(statuses).not.toContain("unauthorized")

      handshake()
      expect(statuses.at(-1)).toBe("connected")
      expect(read).toEqual({})
    })

    it("races the relay alone when a direct address says ready without a challenge", () => {
      setup([direct(LAN), relay(RELAY)])
      socketAt(LAN).open()
      socketAt(LAN).ready()
      expect(socketAt(LAN).closed).toBe(true)
      expect(urls()).toEqual([LAN, RELAY])
      expect(statuses).not.toContain("connected")
    })

    it("stops when the relay's ready proves a different token", () => {
      setup([direct(LAN), relay(RELAY)])
      vi.advanceTimersByTime(RELAY_DELAY_MS)
      socketAt(RELAY).open()
      socketAt(RELAY).challenge()
      socketAt(RELAY).receive({ type: "ready", version: 1, proof: "00" })
      expect(socketAt(RELAY).closed).toBe(true)
      expect(statuses.at(-1)).toBe("unauthorized")
    })

    it("sends nothing to a direct address that does not challenge, and races the relay alone", async () => {
      setup([direct(LAN), relay(RELAY)])
      socketAt(LAN).open()
      await vi.advanceTimersByTimeAsync(CHALLENGE_WAIT_MS - 1)
      expect(socketAt(LAN).sent).toEqual([])
      expect(urls()).toEqual([LAN])
      await vi.advanceTimersByTimeAsync(1)
      expect(socketAt(LAN).sent).toEqual([])
      expect(socketAt(LAN).closed).toBe(true)
      expect(urls()).toEqual([LAN, RELAY])
      expect(statuses).not.toContain("unauthorized")

      handshake()
      expect(statuses.at(-1)).toBe("connected")
    })

    it("sends the token to a relay that does not challenge", async () => {
      setup([direct(LAN), relay(RELAY)])
      await vi.advanceTimersByTimeAsync(RELAY_DELAY_MS)
      socketAt(RELAY).open()
      await vi.advanceTimersByTimeAsync(CHALLENGE_WAIT_MS - 1)
      expect(socketAt(RELAY).sent).toEqual([])
      await vi.advanceTimersByTimeAsync(1)
      expect(socketAt(RELAY).sent).toEqual([{ type: "auth", token: TOKEN, compactEvents: true }])
      socketAt(RELAY).ready()
      expect(statuses.at(-1)).toBe("connected")
    })

    it("sends the token to a direct address that does not challenge when the pairing has no relay", async () => {
      setup([direct(LAN)])
      latest().open()
      await vi.advanceTimersByTimeAsync(CHALLENGE_WAIT_MS - 1)
      expect(latest().sent).toEqual([])
      await vi.advanceTimersByTimeAsync(1)
      expect(latest().sent).toEqual([{ type: "auth", token: TOKEN, compactEvents: true }])
      latest().ready()
      expect(statuses.at(-1)).toBe("connected")
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
