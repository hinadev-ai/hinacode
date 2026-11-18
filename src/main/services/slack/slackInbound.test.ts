import { describe, expect, it } from "vitest"
import {
  type AskEvent,
  type AskState,
  askOf,
  decide,
  decideAsk,
  type DirectMessage,
  isAfter,
  type SlackAsk,
} from "./slackInbound.ts"

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

const mention = (event: Partial<AskEvent["event"]> = {}, envelope: Partial<AskEvent> = {}): AskEvent => ({
  ...envelope,
  event: { type: "app_mention", channel: "C1", ts: "1700000100.000200", user: "U1", text: "<@UBOT> look", ...event },
})

describe("askOf", () => {
  it("places a mention at the top of a channel in a thread of its own", () => {
    expect(askOf(mention())).toEqual({
      channel: "C1",
      ts: "1700000100.000200",
      threadTs: "1700000100.000200",
      inThread: false,
      user: "U1",
      userTeam: null,
      text: "<@UBOT> look",
      external: false,
    })
  })

  it("places a mention inside a thread under that thread's first message", () => {
    expect(askOf(mention({ thread_ts: "1700000000.000100" }))).toMatchObject({
      ts: "1700000100.000200",
      threadTs: "1700000000.000100",
      inThread: true,
    })
  })

  it("reads a direct message", () => {
    expect(askOf(mention({ type: "message", channel_type: "im", channel: "D1" }))).toMatchObject({ channel: "D1" })
  })

  it("carries the sender's workspace and the shared channel mark", () => {
    expect(askOf(mention({ user_team: "T9" }, { is_ext_shared_channel: true }))).toMatchObject({
      userTeam: "T9",
      external: true,
    })
  })

  it.each([
    ["a bot", mention({ bot_id: "B1" })],
    ["an edited message", mention({ subtype: "message_changed" })],
    ["a message with no user", { event: { ...mention().event, user: undefined } }],
    ["a channel message that does not mention the bot", mention({ type: "message", channel_type: "channel" })],
  ])("reads nothing from %s", (_, incoming) => {
    expect(askOf(incoming as AskEvent)).toBeNull()
  })
})

const ask = (fields: Partial<SlackAsk> = {}): SlackAsk => ({ ...askOf(mention())!, ...fields })
const ready: AskState = {
  owner: { teamId: "T1", userId: "U1", name: "Dev Eloper" },
  routine: { id: "r1", enabled: true },
  linked: null,
}
const linked = { threadId: "t1", status: "idle", deliveredTs: "1700000000.000100" } as const

describe("decideAsk", () => {
  it("starts the routine for the paired developer", () => {
    expect(decideAsk(ask(), ready)).toEqual({ type: "start", routineId: "r1" })
  })

  it.each([
    ["someone else", ask({ user: "U2" }), ready],
    ["anyone while nobody is paired", ask(), { ...ready, owner: null }],
    ["the developer's user id from another workspace", ask({ userTeam: "T9" }), ready],
  ])("refuses %s", (_, incoming, state) => {
    expect(decideAsk(incoming, state)).toEqual({ type: "refuse", reason: "notOwner" })
  })

  it("refuses someone else before it says anything about the routine or the thread", () => {
    expect(decideAsk(ask({ user: "U2" }), { owner: ready.owner, routine: null, linked })).toEqual({
      type: "refuse",
      reason: "notOwner",
    })
  })

  it("refuses a channel shared with another organization", () => {
    expect(decideAsk(ask({ external: true }), ready)).toEqual({ type: "refuse", reason: "externalChannel" })
  })

  it.each(["idle", "running"] as const)("continues the linked thread while it is %s", (status) => {
    expect(decideAsk(ask(), { ...ready, linked: { ...linked, status } })).toEqual({ type: "continue", threadId: "t1" })
  })

  it("continues the linked thread with no routine picked", () => {
    expect(decideAsk(ask(), { ...ready, routine: null, linked }).type).toBe("continue")
  })

  it.each(["awaiting_approval", "limited"] as const)("refuses while the linked thread is %s", (status) => {
    expect(decideAsk(ask(), { ...ready, linked: { ...linked, status } })).toEqual({
      type: "refuse",
      reason: "threadWaiting",
    })
  })

  it("ignores a mention the linked thread was already given, whatever its state", () => {
    const given = { ...linked, deliveredTs: "1700000100.000200" }
    expect(decideAsk(ask(), { ...ready, linked: given })).toEqual({ type: "ignore" })
    expect(decideAsk(ask(), { ...ready, linked: { ...given, status: "limited" } })).toEqual({ type: "ignore" })
  })

  it("refuses while no routine is picked", () => {
    expect(decideAsk(ask(), { ...ready, routine: null })).toEqual({ type: "refuse", reason: "noRoutine" })
  })

  it("refuses while the routine is paused", () => {
    expect(decideAsk(ask(), { ...ready, routine: { id: "r1", enabled: false } })).toEqual({
      type: "refuse",
      reason: "routineDisabled",
    })
  })
})

describe("isAfter", () => {
  it.each([
    ["1700000100.000200", "1700000100.000100", true],
    ["1700000100.000200", "1700000100.000200", false],
    ["1700000100.000200", "1700000101.000000", false],
    ["1700000100.000010", "1700000100.000009", true],
    ["10000000000.000001", "9999999999.999999", true],
  ])("%s after %s is %s", (ts, other, expected) => {
    expect(isAfter(ts, other)).toBe(expected)
  })
})
