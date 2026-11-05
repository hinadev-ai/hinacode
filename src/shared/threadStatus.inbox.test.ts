import { describe, expect, test } from "@effect/vitest"
import { inboxGroup, type RowState } from "./threadStatus.ts"

const now = Date.parse("2026-11-04T00:00:00.000Z")
const recent = "2026-11-03T00:00:00.000Z"
const quiet = "2026-10-20T00:00:00.000Z"

describe("inboxGroup", () => {
  test("anything that stopped on the developer or finished needs them", () => {
    const states: ReadonlyArray<RowState> = [
      "awaiting_approval",
      "limited",
      "unseen_completed",
      "unseen_failed",
      "pr_conflicting",
      "pr_checksFailing",
      "pr_changesRequested",
    ]
    for (const state of states) expect(inboxGroup(state, null, quiet, false, now)).toBe("ready")
  })

  test("a thread they have read stays until it settles", () => {
    expect(inboxGroup("idle", null, recent, false, now)).toBe("ready")
    expect(inboxGroup("idle", null, recent, true, now)).toBe("ready")
  })

  test("an agent at work is working", () => {
    expect(inboxGroup("running", null, recent, false, now)).toBe("working")
    expect(inboxGroup("background", null, recent, false, now)).toBe("working")
  })

  test("a read thread with no open pull request settles after a quiet week", () => {
    expect(inboxGroup("idle", null, quiet, false, now)).toBe("settled")
    expect(inboxGroup("idle", null, quiet, true, now)).toBe("ready")
  })

  test("a settled thread stays settled until it works again", () => {
    expect(inboxGroup("idle", recent, recent, false, now)).toBe("settled")
    expect(inboxGroup("pr_conflicting", recent, recent, true, now)).toBe("settled")
    expect(inboxGroup("running", recent, recent, false, now)).toBe("working")
  })

  test("archived is its own group", () => {
    expect(inboxGroup("archived", null, recent, false, now)).toBe("archived")
  })
})
