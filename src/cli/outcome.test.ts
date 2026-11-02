import { describe, expect, test } from "@effect/vitest"
import type { AgentEvent } from "../shared/agent.ts"
import type { PushEvent } from "../shared/contract.ts"
import { outcomeOf } from "./outcome.ts"

const event = (agentEvent: AgentEvent, threadId = "t1"): PushEvent => ({
  type: "thread.event",
  seq: 1,
  threadId,
  event: agentEvent,
})

const approval: AgentEvent = {
  type: "approval_requested",
  request: { id: "a1", threadId: "t1", provider: "claude", kind: "command", title: "Bash", detail: "", input: {} },
}

describe("outcomeOf", () => {
  test("maps the events that end a wait to an outcome", () => {
    expect(outcomeOf(event({ type: "turn_completed" }), "t1")).toStrictEqual({ outcome: "done" })
    expect(outcomeOf(event({ type: "turn_failed", message: "boom" }), "t1")).toStrictEqual({
      outcome: "failed",
      message: "boom",
    })
    expect(
      outcomeOf(event({ type: "turn_limited", limit: { kind: "usage", message: "limit hit", reset: null } }), "t1"),
    ).toStrictEqual({ outcome: "limited", message: "limit hit" })
    expect(outcomeOf(event(approval), "t1")).toStrictEqual({ outcome: "needsHuman" })
    expect(
      outcomeOf(
        event({ type: "question_requested", request: { id: "q1", threadId: "t1", provider: "codex", questions: [] } }),
        "t1",
      ),
    ).toStrictEqual({ outcome: "needsHuman" })
    expect(
      outcomeOf(
        event({ type: "secret_requested", request: { id: "s1", threadId: "t1", name: "KEY", description: "" } }),
        "t1",
      ),
    ).toStrictEqual({ outcome: "needsHuman" })
  })

  test("ignores other threads, other events and other pushes", () => {
    expect(outcomeOf(event({ type: "turn_completed" }, "t2"), "t1")).toBeUndefined()
    expect(outcomeOf(event({ type: "text_delta", text: "hi" }), "t1")).toBeUndefined()
    expect(outcomeOf({ type: "thread.removed", id: "t1" }, "t1")).toBeUndefined()
  })
})
