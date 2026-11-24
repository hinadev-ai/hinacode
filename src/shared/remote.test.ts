import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import { encodeKey, generateKeyPair } from "./noise.ts"
import {
  ClientFrame,
  isPortInUse,
  LegacyAuth,
  normalizeApprovalCode,
  pairingUrl,
  parsePairingUrl,
  dialPlan,
  RELAY_DELAY_MS,
  remoteWebSocketUrl,
  TAILSCALE_DELAY_MS,
  ServerFrame,
} from "./remote.ts"

const KEY = encodeKey(generateKeyPair().publicKey)

describe("remote frames", () => {
  it("keeps the compact-events choice in hello", () => {
    for (const compactEvents of [true, false]) {
      const frame = { type: "hello", name: "phone", compactEvents }
      expect(Schema.decodeUnknownSync(ClientFrame)(frame)).toEqual(frame)
    }
    expect(Schema.decodeUnknownOption(ClientFrame)({ type: "hello", name: "phone", compactEvents: "true" })._tag).toBe(
      "None",
    )
  })

  it("refuses a hello without a name or with a name longer than 64 characters", () => {
    expect(Schema.decodeUnknownOption(ClientFrame)({ type: "hello", name: "" })._tag).toBe("None")
    expect(Schema.decodeUnknownOption(ClientFrame)({ type: "hello", name: "a".repeat(65) })._tag).toBe("None")
  })

  it("takes approval nonces only as 64 lowercase hex characters", () => {
    const nonce = "ab".repeat(32)
    expect(Schema.decodeUnknownSync(ClientFrame)({ type: "approval", nonce })).toEqual({ type: "approval", nonce })
    expect(Schema.decodeUnknownOption(ClientFrame)({ type: "approval", nonce: "ab" })._tag).toBe("None")
    expect(Schema.decodeUnknownOption(ServerFrame)({ type: "pending", commitment: "AB".repeat(32) })._tag).toBe("None")
  })

  it("keeps the old auth frames out of the session protocol", () => {
    const auth = { type: "auth", token: "token" }
    expect(Schema.decodeUnknownOption(ClientFrame)(auth)._tag).toBe("None")
    expect(Schema.decodeUnknownSync(LegacyAuth)(auth)).toEqual(auth)
    expect(Schema.decodeUnknownOption(ServerFrame)({ type: "challenge", nonce: "n" })._tag).toBe("None")
  })

  it("keeps known capabilities when ready advertises a future feature", () => {
    const ready = { type: "ready", version: 2, features: ["heartbeat", "some-future-feature"] }
    const frame = Schema.decodeUnknownSync(ServerFrame)(ready)
    expect(frame).toEqual(ready)
    expect(frame.type).toBe("ready")
    if (frame.type !== "ready") throw new Error("Expected ready frame")
    expect(frame.features?.includes("heartbeat")).toBe(true)
  })

  it("accepts a future method without dropping its call key", () => {
    const frame = { type: "call", id: 1, method: "future.method", key: "action-1" }
    expect(Schema.decodeUnknownSync(ClientFrame)(frame)).toEqual(frame)
  })

  it("decodes application heartbeats and the advertised features", () => {
    expect(Schema.decodeUnknownSync(ClientFrame)({ type: "ping", at: 123 })).toEqual({ type: "ping", at: 123 })
    expect(Schema.decodeUnknownSync(ServerFrame)({ type: "pong", at: 123 })).toEqual({ type: "pong", at: 123 })
    const ready = { type: "ready", version: 1, features: ["heartbeat", "call-keys"] }
    expect(Schema.decodeUnknownSync(ServerFrame)(ready)).toEqual(ready)
    expect(Schema.decodeUnknownSync(ServerFrame)({ type: "ready", version: 1 })).toEqual({ type: "ready", version: 1 })
  })

  it("lets a cloud ask a desktop for the thread tools' calls and nothing else", () => {
    const ask = { type: "ask", id: 1, method: "threads.transcript", payload: { threadId: "t" } }
    expect(Schema.decodeUnknownSync(ServerFrame)(ask)).toEqual(ask)
    expect(Schema.decodeUnknownOption(ServerFrame)({ ...ask, method: "threads.delete" })._tag).toBe("None")
    expect(Schema.decodeUnknownOption(ServerFrame)({ ...ask, method: "fs.write" })._tag).toBe("None")
  })

  it("decodes the desktop's hub offer and its answers", () => {
    expect(Schema.decodeUnknownSync(ClientFrame)({ type: "hub" })).toEqual({ type: "hub" })
    const answered = { type: "answer", id: 1, envelope: { result: [] } }
    expect(Schema.decodeUnknownSync(ClientFrame)(answered)).toEqual(answered)
    const failed = { type: "answer", id: 2, envelope: { error: { tag: "NotFoundError", message: "gone" } } }
    expect(Schema.decodeUnknownSync(ClientFrame)(failed)).toEqual(failed)
  })
})

describe("isPortInUse", () => {
  it("recognizes the error Node gives for a taken port", () => {
    expect(isPortInUse("listen EADDRINUSE: address already in use 0.0.0.0:48081")).toBe(true)
    expect(isPortInUse("listen EACCES: permission denied 0.0.0.0:80")).toBe(false)
  })
})

describe("approval codes", () => {
  it.each([
    ["K7Q-F2M", "K7Q-F2M"],
    ["k7qf2m", "K7Q-F2M"],
    [" k7q f2m ", "K7Q-F2M"],
    ["O1L-I00", "011-100"],
  ])("reads %j as %s", (typed, code) => {
    expect(normalizeApprovalCode(typed)).toBe(code)
  })

  it.each(["K7Q-F2", "K7Q-F2MM", "K7Q-F2U", "K7Q_F2M", ""])("refuses %j", (typed) => {
    expect(normalizeApprovalCode(typed)).toBeNull()
  })
})

describe("pairing URLs", () => {
  it("round-trips every host in order, the host key and the secret", () => {
    const target = {
      hosts: ["100.64.0.2", "192.168.1.5", "mac.local", "fd7a:115c::2"],
      port: 47821,
      relay: null,
      key: KEY,
      secret: "s/c+t",
    } as const
    const url = pairingUrl(target)
    expect(url).toBe(
      `hinacode://connect?host=100.64.0.2&host=192.168.1.5&host=mac.local&host=fd7a%3A115c%3A%3A2&port=47821&key=${KEY}&secret=s%2Fc%2Bt`,
    )
    expect(parsePairingUrl(url)).toEqual(target)
  })

  it("leaves the secret out for a machine learned through the relay", () => {
    const target = {
      hosts: ["100.64.0.2"],
      port: 47821,
      relay: "hinacode-1a2b3c4d.example.com",
      key: KEY,
      secret: null,
    } as const
    const url = pairingUrl(target)
    expect(url).toBe(`hinacode://connect?relay=hinacode-1a2b3c4d.example.com&host=100.64.0.2&port=47821&key=${KEY}`)
    expect(parsePairingUrl(url)).toEqual(target)
  })

  it("never writes a token, and ignores one in a URL it reads", () => {
    const url = pairingUrl({ hosts: ["a"], port: 1, relay: null, key: KEY, secret: "s" })
    expect(url).not.toContain("token")
    expect(parsePairingUrl(`${url}&token=old`)).toEqual({ hosts: ["a"], port: 1, relay: null, key: KEY, secret: "s" })
  })

  it("finds the URL inside the lines hinacode serve prints", () => {
    const printed = [
      "hinacode serve is listening on port 47821",
      "pair a desktop with one of:",
      `  hinacode://connect?host=100.64.0.2&host=192.0.2.10&port=47821&key=${KEY}&secret=abc`,
      `  hinacode://connect?host=192.0.2.10&port=47821&key=${KEY}&secret=abc`,
    ].join("\n")
    expect(parsePairingUrl(printed)).toEqual({
      hosts: ["100.64.0.2", "192.0.2.10"],
      port: 47821,
      relay: null,
      key: KEY,
      secret: "abc",
    })
  })

  it("finds the URL between words on one line", () => {
    expect(parsePairingUrl(`pair with hinacode://connect?host=a&port=1&key=${KEY}\tthen connect`)).toEqual({
      hosts: ["a"],
      port: 1,
      relay: null,
      key: KEY,
      secret: null,
    })
  })

  it.each([
    ["text without a pairing URL", "pair a desktop with one of:"],
    ["a pairing URL glued to a word", `url:hinacode://connect?host=a&port=1&key=${KEY}`],
    ["another scheme", `https://connect?host=a&port=1&key=${KEY}`],
    ["another action", `hinacode://pair?host=a&port=1&key=${KEY}`],
    ["no host", `hinacode://connect?port=1&key=${KEY}`],
    ["an empty host", `hinacode://connect?host=a&host=&port=1&key=${KEY}`],
    ["a host with a path", `hinacode://connect?host=a%2Fb&port=1&key=${KEY}`],
    ["a host with credentials", `hinacode://connect?host=evil%40a&port=1&key=${KEY}`],
    ["a bracketed host", `hinacode://connect?host=%5B%3A%3A1%5D&port=1&key=${KEY}`],
    ["an invalid IPv6 address", `hinacode://connect?host=1%3A%3A2%3A%3A3&port=1&key=${KEY}`],
    ["a port out of range", `hinacode://connect?host=a&port=65536&key=${KEY}`],
    ["no key, as every pairing before encryption", "hinacode://connect?host=a&port=1&token=t"],
    ["a key that is not 32 bytes", `hinacode://connect?host=a&port=1&key=${KEY.slice(0, 40)}`],
    ["a padded key", `hinacode://connect?host=a&port=1&key=${KEY}%3D`],
    ["a relay with a port", `hinacode://connect?relay=r.example.com%3A8443&host=a&port=1&key=${KEY}`],
    ["a relay with a path", `hinacode://connect?relay=r.example.com%2Fx&host=a&port=1&key=${KEY}`],
    ["a relay that is not a domain name", `hinacode://connect?relay=localhost&host=a&port=1&key=${KEY}`],
  ])("refuses %s", (_, text) => {
    expect(parsePairingUrl(text)).toBeNull()
  })

  it("brackets an IPv6 host in the socket URL", () => {
    expect(remoteWebSocketUrl({ host: "fd7a:115c::2", port: 47821 })).toBe("ws://[fd7a:115c::2]:47821/remote")
    expect(remoteWebSocketUrl({ host: "mac.local", port: 47821 })).toBe("ws://mac.local:47821/remote")
  })

  it("dials the direct addresses at once and the relay a moment later", () => {
    expect(dialPlan({ hosts: ["100.64.0.2", "mac.local"], port: 47821, relay: "r.example.com" })).toEqual([
      { url: "ws://100.64.0.2:47821/remote", route: "direct", delayMs: TAILSCALE_DELAY_MS },
      { url: "ws://mac.local:47821/remote", route: "direct", delayMs: 0 },
      { url: "wss://r.example.com/remote", route: "relay", delayMs: RELAY_DELAY_MS },
    ])
    expect(dialPlan({ hosts: ["100.64.0.2"], port: 47821, relay: null })).toEqual([
      { url: "ws://100.64.0.2:47821/remote", route: "direct", delayMs: 0 },
    ])
    expect(dialPlan({ hosts: ["100.20.0.2", "100.example.com"], port: 47821, relay: null })).toEqual([
      { url: "ws://100.20.0.2:47821/remote", route: "direct", delayMs: 0 },
      { url: "ws://100.example.com:47821/remote", route: "direct", delayMs: 0 },
    ])
    expect(dialPlan({ hosts: ["mac.local"], port: 47821, relay: null })).toEqual([
      { url: "ws://mac.local:47821/remote", route: "direct", delayMs: 0 },
    ])
  })
})
