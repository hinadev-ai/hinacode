import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import { ClientFrame, pairingUrl, parsePairingUrl, remoteWebSocketUrl, ServerFrame } from "./remote.ts"

describe("remote frames", () => {
  it("keeps known capabilities when ready advertises a future feature", () => {
    const ready = { type: "ready", version: 1, features: ["heartbeat", "some-future-feature"] }
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
})

describe("pairing URLs", () => {
  it("round-trips every host in order", () => {
    const target = {
      hosts: ["100.64.0.2", "192.168.1.5", "mac.local", "fd7a:115c::2"],
      port: 47821,
      token: "t/k+n",
    } as const
    const url = pairingUrl(target)
    expect(url).toBe(
      "hinacode://connect?host=100.64.0.2&host=192.168.1.5&host=mac.local&host=fd7a%3A115c%3A%3A2&port=47821&token=t%2Fk%2Bn",
    )
    expect(parsePairingUrl(url)).toEqual(target)
  })

  it("reads the single-host form that older desktops print", () => {
    expect(parsePairingUrl(" hinacode://connect?host=192.168.1.5&port=47821&token=abc\n")).toEqual({
      hosts: ["192.168.1.5"],
      port: 47821,
      token: "abc",
    })
  })

  it("finds the URL inside the lines hinacode serve prints", () => {
    const printed = [
      "hinacode serve is listening on port 47821",
      "pair a desktop with one of:",
      "  hinacode://connect?host=100.64.0.2&host=192.0.2.10&port=47821&token=abc",
      "  hinacode://connect?host=192.0.2.10&port=47821&token=abc",
    ].join("\n")
    expect(parsePairingUrl(printed)).toEqual({ hosts: ["100.64.0.2", "192.0.2.10"], port: 47821, token: "abc" })
  })

  it("finds the URL between words on one line", () => {
    expect(parsePairingUrl("pair with hinacode://connect?host=a&port=1&token=t\tthen connect")).toEqual({
      hosts: ["a"],
      port: 1,
      token: "t",
    })
  })

  it.each([
    ["text without a pairing URL", "pair a desktop with one of:"],
    ["a pairing URL glued to a word", "url:hinacode://connect?host=a&port=1&token=t"],
    ["another scheme", "https://connect?host=a&port=1&token=t"],
    ["another action", "hinacode://pair?host=a&port=1&token=t"],
    ["no host", "hinacode://connect?port=1&token=t"],
    ["an empty host", "hinacode://connect?host=a&host=&port=1&token=t"],
    ["a host with a path", "hinacode://connect?host=a%2Fb&port=1&token=t"],
    ["a host with credentials", "hinacode://connect?host=evil%40a&port=1&token=t"],
    ["a bracketed host", "hinacode://connect?host=%5B%3A%3A1%5D&port=1&token=t"],
    ["an invalid IPv6 address", "hinacode://connect?host=1%3A%3A2%3A%3A3&port=1&token=t"],
    ["a port out of range", "hinacode://connect?host=a&port=65536&token=t"],
    ["no token", "hinacode://connect?host=a&port=1"],
  ])("refuses %s", (_, text) => {
    expect(parsePairingUrl(text)).toBeNull()
  })

  it("brackets an IPv6 host in the socket URL", () => {
    expect(remoteWebSocketUrl({ host: "fd7a:115c::2", port: 47821 })).toBe("ws://[fd7a:115c::2]:47821/remote")
    expect(remoteWebSocketUrl({ host: "mac.local", port: 47821 })).toBe("ws://mac.local:47821/remote")
  })
})
