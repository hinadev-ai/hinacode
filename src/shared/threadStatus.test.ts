import { expect, it } from "vitest"
import type { AgentEvent } from "./agent.ts"
import { openChecks, outcomeOf, rowState } from "./threadStatus.ts"

it("shows an unopened result only on an idle thread", () => {
  expect(rowState("idle", "completed")).toBe("unseen_completed")
  expect(rowState("idle", "failed")).toBe("unseen_failed")
  expect(rowState("idle", undefined)).toBe("idle")
  expect(rowState("running", "completed")).toBe("running")
})

it("marks a finished or failed turn, not a limited one", () => {
  expect(outcomeOf({ type: "turn_completed" } as AgentEvent)).toBe("completed")
  expect(outcomeOf({ type: "turn_failed", message: "boom" } as AgentEvent)).toBe("failed")
  expect(outcomeOf({ type: "turn_limited" } as AgentEvent)).toBeUndefined()
  expect(outcomeOf({ type: "text_delta", text: "hi" } as AgentEvent)).toBeUndefined()
})

it("shows checks only while the pull request is open or a draft", () => {
  expect(openChecks({ status: "open", checks: "failing" })).toBe("failing")
  expect(openChecks({ status: "draft", checks: "pending" })).toBe("pending")
  expect(openChecks({ status: "merged", checks: "failing" })).toBeNull()
  expect(openChecks(undefined)).toBeNull()
})
