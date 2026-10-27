import { expect, it } from "vitest"
import type { AgentEvent } from "./agent.ts"
import { openChecks, outcomeOf, pullRequestAttention, rowState } from "./threadStatus.ts"

it("shows an unopened result only on an idle thread", () => {
  expect(rowState("idle", "completed", undefined)).toBe("unseen_completed")
  expect(rowState("idle", "failed", undefined)).toBe("unseen_failed")
  expect(rowState("idle", undefined, undefined)).toBe("idle")
  expect(rowState("running", "completed", undefined)).toBe("running")
})

it("shows a pull request waiting on the developer after the thread's own status and unopened result", () => {
  expect(rowState("idle", undefined, "checksFailing")).toBe("pr_checksFailing")
  expect(rowState("idle", "completed", "checksFailing")).toBe("unseen_completed")
  expect(rowState("awaiting_approval", undefined, "conflicting")).toBe("awaiting_approval")
  expect(rowState("archived", undefined, "conflicting")).toBe("archived")
})

const fine = { status: "open", checks: "passing", review: null, mergeable: "mergeable" } as const

it("names the most urgent reason across a thread's open pull requests", () => {
  expect(pullRequestAttention([fine, undefined])).toBeUndefined()
  expect(pullRequestAttention([{ ...fine, review: "changesRequested" }])).toBe("changesRequested")
  expect(pullRequestAttention([{ ...fine, status: "draft", checks: "failing" }])).toBe("checksFailing")
  expect(
    pullRequestAttention([
      { ...fine, checks: "failing", review: "changesRequested" },
      { ...fine, mergeable: "conflicting" },
    ]),
  ).toBe("conflicting")
})

it("ignores a merged or closed pull request", () => {
  expect(pullRequestAttention([{ ...fine, status: "merged", checks: "failing" }])).toBeUndefined()
  expect(pullRequestAttention([{ ...fine, status: "closed", mergeable: "conflicting" }])).toBeUndefined()
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
