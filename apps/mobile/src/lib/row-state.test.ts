import type { AgentEvent } from "@shared/agent.ts"
import { expect, it } from "vitest"
import { outcomeOf, rowEmphasis, rowState } from "./row-state"

it("shows an unopened result only on an idle thread", () => {
  expect(rowState("idle", "completed")).toBe("unseen_completed")
  expect(rowState("idle", "failed")).toBe("unseen_failed")
  expect(rowState("idle", undefined)).toBe("idle")
  expect(rowState("running", "completed")).toBe("running")
})

it("reads threads that need the developer loudest and working ones quietest", () => {
  expect(rowEmphasis[rowState("awaiting_approval", undefined)]).toBe("attention")
  expect(rowEmphasis[rowState("idle", "failed")]).toBe("attention")
  expect(rowEmphasis[rowState("idle", undefined)]).toBe("resting")
  expect(rowEmphasis[rowState("running", undefined)]).toBe("working")
})

it("marks a finished or failed turn, not a limited one", () => {
  expect(outcomeOf({ type: "turn_completed" } as AgentEvent)).toBe("completed")
  expect(outcomeOf({ type: "turn_failed", message: "boom" } as AgentEvent)).toBe("failed")
  expect(outcomeOf({ type: "turn_limited" } as AgentEvent)).toBeUndefined()
  expect(outcomeOf({ type: "text_delta", text: "hi" } as AgentEvent)).toBeUndefined()
})
