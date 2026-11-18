import { describe, expect, it } from "vitest"
import { decide, type DirectMessage } from "./slackInbound.ts"

const message = (event: Partial<DirectMessage["event"]>): DirectMessage => ({
  event: { type: "message", channel_type: "im", channel: "D1", ts: "1700000000.000100", user: "U1", ...event },
})

const pairing = { pairingCode: "ABCD2345" }

describe("decide", () => {
  it("pairs the sender of the pairing code", () => {
    expect(decide(message({ text: "ABCD2345" }), pairing)).toEqual({
      type: "pair",
      userId: "U1",
      message: { channel: "D1", ts: "1700000000.000100" },
    })
  })

  it("reads the code without its case or surrounding space", () => {
    expect(decide(message({ text: "  abcd2345\n" }), pairing).type).toBe("pair")
  })

  it.each([
    ["another text", message({ text: "ABCD2346" })],
    ["a code inside a sentence", message({ text: "my code is ABCD2345" })],
    ["no text", message({})],
    ["a bot", message({ text: "ABCD2345", bot_id: "B1" })],
    ["an edited message", message({ text: "ABCD2345", subtype: "message_changed" })],
    ["a message with no user", { event: { ...message({ text: "ABCD2345" }).event, user: undefined } }],
  ])("ignores %s", (_, incoming) => {
    expect(decide(incoming as DirectMessage, pairing)).toEqual({ type: "ignore" })
  })

  it("ignores every message while no code is waiting", () => {
    expect(decide(message({ text: "ABCD2345" }), { pairingCode: null })).toEqual({ type: "ignore" })
  })
})
