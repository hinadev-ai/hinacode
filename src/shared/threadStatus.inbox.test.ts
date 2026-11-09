import { describe, expect, test } from "@effect/vitest"
import { inboxGroup, type RowState } from "./threadStatus.ts"

const settledAt = "2026-11-03T00:00:00.000Z"

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
    for (const state of states) expect(inboxGroup(state, null)).toBe("ready")
  })

  test("a thread they have read stays until it settles", () => {
    expect(inboxGroup("idle", null)).toBe("ready")
  })

  test("an agent at work stays ready", () => {
    expect(inboxGroup("running", null)).toBe("ready")
    expect(inboxGroup("background", null)).toBe("ready")
  })

  test("a settled thread stays settled until it works again", () => {
    expect(inboxGroup("idle", settledAt)).toBe("settled")
    expect(inboxGroup("pr_conflicting", settledAt)).toBe("settled")
    expect(inboxGroup("running", settledAt)).toBe("ready")
  })

  test("archived is its own group", () => {
    expect(inboxGroup("archived", null)).toBe("archived")
  })
})
