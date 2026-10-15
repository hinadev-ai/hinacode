import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  CLOSE_TOKEN_ROTATED,
  CLOSE_UNAUTHORIZED,
  LOST_REPLY_MESSAGE,
  MAY_HAVE_RUN_MESSAGE,
  NOT_SENT_MESSAGE,
  type SocketLike,
  Transport,
  type TransportStatus,
} from "./transport"

class FakeSocket implements SocketLike {
  onopen: (() => void) | null = null
  onmessage: ((message: { data: unknown }) => void) | null = null
  onclose: ((event: { code: number }) => void) | null = null
  readonly sent: Record<string, unknown>[] = []
  closed = false

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
  ready(features: readonly string[] = ["heartbeat", "call-keys", "terminal-attach"], version = 1) {
    this.receive({ type: "ready", version, features })
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

function setup(urls: readonly [string, ...string[]] = ["ws://desktop/remote"]) {
  sockets = []
  statuses = []
  ready = 0
  keys = 0
  const transport = new Transport({
    urls,
    token: "secret",
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

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe("Transport", () => {
  it("authenticates first and reports connected after ready", () => {
    setup()
    expect(statuses).toEqual(["connecting"])
    latest().open()
    expect(latest().sent).toEqual([{ type: "auth", token: "secret" }])
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
        urls: ["ws://desktop/remote"],
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
      latest().ready([], 2)
      await vi.advanceTimersByTimeAsync(60_000)
      expect(statuses.at(-1)).toBe("unauthorized")
      expect(sockets).toHaveLength(1)
      expect(read.error).toMatchObject({ tag: "Unauthorized" })
    })
  })

  describe("several addresses", () => {
    const TAILSCALE = "ws://100.64.0.2:47821/remote"
    const LAN = "ws://192.168.1.5:47821/remote"
    const HOSTNAME = "ws://mac.local:47821/remote"
    const urls = () => sockets.map((socket) => socket.url)

    it("falls back to the next address when the first never answers, then keeps the one that worked", async () => {
      const transport = setup([TAILSCALE, LAN])
      const read = track(transport.call("threads.list", undefined))
      await vi.advanceTimersByTimeAsync(10_000)
      expect(sockets[0]!.closed).toBe(true)
      await vi.advanceTimersByTimeAsync(500)
      expect(urls()).toEqual([TAILSCALE, LAN])
      handshake()
      expect(latest().calls()).toEqual([{ type: "call", id: 1, method: "threads.list" }])
      latest().result(1, [])
      await vi.advanceTimersByTimeAsync(0)
      expect(read.value).toEqual({ result: [] })

      latest().drop()
      await vi.advanceTimersByTimeAsync(500)
      expect(urls().at(-1)).toBe(LAN)
    })

    it("moves on at each failed attempt, in order, wrapping around", async () => {
      setup([TAILSCALE, LAN, HOSTNAME])
      latest().drop()
      await vi.advanceTimersByTimeAsync(500)
      latest().open()
      latest().drop(4003)
      await vi.advanceTimersByTimeAsync(1_000)
      await vi.advanceTimersByTimeAsync(10_000)
      await vi.advanceTimersByTimeAsync(4_000)
      expect(urls()).toEqual([TAILSCALE, LAN, HOSTNAME, TAILSCALE])

      handshake()
      latest().drop()
      await vi.advanceTimersByTimeAsync(500)
      latest().drop()
      await vi.advanceTimersByTimeAsync(1_000)
      expect(urls().slice(4)).toEqual([TAILSCALE, LAN])
    })

    it("starts from the address that worked when the network changes or the app returns", async () => {
      const transport = setup([TAILSCALE, LAN])
      latest().drop()
      await vi.advanceTimersByTimeAsync(500)
      handshake()

      transport.networkChanged()
      expect(urls().at(-1)).toBe(LAN)
      latest().drop()
      transport.networkChanged()
      expect(urls().at(-1)).toBe(LAN)

      latest().drop()
      transport.setForeground(false)
      transport.setForeground(true)
      expect(urls().at(-1)).toBe(LAN)
      latest().drop()
      await vi.advanceTimersByTimeAsync(1_000)
      expect(urls().at(-1)).toBe(TAILSCALE)
    })

    it("stops on a refused token instead of trying the other addresses", async () => {
      setup([TAILSCALE, LAN])
      latest().open()
      latest().drop(CLOSE_UNAUTHORIZED)
      await vi.advanceTimersByTimeAsync(60_000)
      expect(urls()).toEqual([TAILSCALE])
      expect(statuses.at(-1)).toBe("unauthorized")
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
