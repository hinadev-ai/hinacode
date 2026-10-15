import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import { ClientFrame, ServerFrame } from "./remote.ts"

describe("remote frames", () => {
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
