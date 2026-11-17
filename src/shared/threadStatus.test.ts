import { expect, it } from "vitest"
import type { AgentEvent } from "./agent.ts"
import type { ThreadStatus } from "./domain.ts"
import { openChecks, outcomeOf, pullRequestAttention, rowState } from "./threadStatus.ts"

const thread = (status: ThreadStatus, interruptedAt: string | null = null) => ({ status, interruptedAt })
const RESTARTED_AT = "2026-11-10T03:00:00.000Z"

it("shows an unopened result only on an idle thread", () => {
  expect(rowState(thread("idle"), false, "completed", undefined)).toBe("unseen_completed")
  expect(rowState(thread("idle"), false, "failed", undefined)).toBe("unseen_failed")
  expect(rowState(thread("idle"), false, undefined, undefined)).toBe("idle")
  expect(rowState(thread("running"), false, "completed", undefined)).toBe("running")
})

it("shows a pull request waiting on the developer after the thread's own status and unopened result", () => {
  expect(rowState(thread("idle"), false, undefined, "checksFailing")).toBe("pr_checksFailing")
  expect(rowState(thread("idle"), false, "completed", "checksFailing")).toBe("unseen_completed")
  expect(rowState(thread("awaiting_approval"), false, undefined, "conflicting")).toBe("awaiting_approval")
  expect(rowState(thread("archived"), false, undefined, "conflicting")).toBe("archived")
})

it("shows background work instead of a finished turn, but not instead of a failed one", () => {
  expect(rowState(thread("idle"), true, "completed", undefined)).toBe("background")
  expect(rowState(thread("idle"), true, undefined, "checksFailing")).toBe("background")
  expect(rowState(thread("idle"), true, "failed", undefined)).toBe("unseen_failed")
  expect(rowState(thread("running"), true, undefined, undefined)).toBe("running")
})

it("shows a thread a restart stopped ahead of its unopened result and pull request, until it runs or is archived", () => {
  expect(rowState(thread("idle", RESTARTED_AT), false, "failed", "checksFailing")).toBe("interrupted")
  expect(rowState(thread("running", RESTARTED_AT), false, undefined, undefined)).toBe("running")
  expect(rowState(thread("archived", RESTARTED_AT), false, undefined, undefined)).toBe("archived")
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
  expect(outcomeOf({ type: "turn_failed", message: "Interrupted", stopped: true } as AgentEvent)).toBeUndefined()
  expect(outcomeOf({ type: "turn_limited" } as AgentEvent)).toBeUndefined()
  expect(outcomeOf({ type: "text_delta", text: "hi" } as AgentEvent)).toBeUndefined()
})

it("shows checks only while the pull request is open or a draft", () => {
  expect(openChecks({ status: "open", checks: "failing" })).toBe("failing")
  expect(openChecks({ status: "draft", checks: "pending" })).toBe("pending")
  expect(openChecks({ status: "merged", checks: "failing" })).toBeNull()
  expect(openChecks(undefined)).toBeNull()
})
