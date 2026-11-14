import { describe, expect, test } from "@effect/vitest"
import type { AgentEvent, ApprovalRequest, QuestionRequest, SecretRequest } from "../../shared/agent.ts"
import type { UsageLimit } from "../../shared/limits.ts"
import { initialTurnState, step, type TurnInputs, type TurnState } from "./turnState.ts"

const idle: TurnInputs = { waitsOnUser: false }
const waiting: TurnInputs = { waitsOnUser: true }
const running = initialTurnState("session-1")
const awaiting: TurnState = { ...running, status: "awaiting_approval" }

const approval = { id: "approval-1", threadId: "thread-1" } as ApprovalRequest
const question = { id: "question-1", threadId: "thread-1" } as QuestionRequest
const secret: SecretRequest = { id: "secret-1", threadId: "thread-1", name: "TOKEN", description: "" }
const limit: UsageLimit = { kind: "usage", message: "Limit reached", reset: null }

describe("initialTurnState", () => {
  test("starts running with no outcome", () => {
    expect(initialTurnState(null)).toEqual({ status: "running", outcome: null, resumedSessionId: null })
  })
})

describe("step", () => {
  test.each<AgentEvent>([
    { type: "approval_requested", request: approval },
    { type: "question_requested", request: question },
    { type: "secret_requested", request: secret },
  ])("$type waits on the user", (event) => {
    expect(step(running, event, waiting)).toEqual([awaiting, [{ type: "set_status", status: "awaiting_approval" }]])
  })

  test("a second request while waiting changes nothing", () => {
    expect(step(awaiting, { type: "question_requested", request: question }, waiting)).toEqual([awaiting, []])
  })

  test.each<AgentEvent>([
    { type: "approval_resolved", requestId: approval.id },
    { type: "question_resolved", requestId: question.id },
    { type: "secret_resolved", requestId: secret.id },
  ])("$type resumes the turn and steers held messages", (event) => {
    expect(step(awaiting, event, idle)).toEqual([
      running,
      [{ type: "set_status", status: "running" }, { type: "steer_held" }],
    ])
  })

  test("resolving one of two open requests keeps waiting and still offers held messages", () => {
    expect(step(awaiting, { type: "approval_resolved", requestId: approval.id }, waiting)).toEqual([
      awaiting,
      [{ type: "steer_held" }],
    ])
  })

  test("a resolution while already running only steers held messages", () => {
    expect(step(running, { type: "secret_resolved", requestId: secret.id }, idle)).toEqual([
      running,
      [{ type: "steer_held" }],
    ])
  })

  test("turn_completed goes idle and records the outcome", () => {
    expect(step(running, { type: "turn_completed" }, idle)).toEqual([
      { ...running, status: "idle", outcome: "completed" },
      [{ type: "set_status", status: "idle" }],
    ])
  })

  test("turn_failed keeps the session unless it was lost", () => {
    expect(step(awaiting, { type: "turn_failed", message: "boom" }, waiting)).toEqual([
      { ...running, status: "idle", outcome: "failed" },
      [{ type: "set_status", status: "idle" }],
    ])
  })

  test("turn_failed with sessionLost drops the session before going idle", () => {
    expect(step(running, { type: "turn_failed", message: "gone", sessionLost: true }, idle)).toEqual([
      { ...running, status: "idle", outcome: "failed" },
      [{ type: "drop_session" }, { type: "set_status", status: "idle" }],
    ])
  })

  test("turn_failed after turn_completed overwrites the outcome without another status write", () => {
    const completed: TurnState = { ...running, status: "idle", outcome: "completed" }
    expect(step(completed, { type: "turn_failed", message: "late" }, idle)).toEqual([
      { ...completed, outcome: "failed" },
      [],
    ])
  })

  test("turn_limited writes the limit with the status and leaves the outcome open", () => {
    expect(step(running, { type: "turn_limited", limit }, idle)).toEqual([
      { ...running, status: "limited" },
      [{ type: "set_status", status: "limited", usageLimit: limit }],
    ])
  })

  test("session_bound writes a session that differs from the one the turn resumed", () => {
    expect(step(running, { type: "session_bound", providerSessionId: "session-2" }, idle)).toEqual([
      running,
      [{ type: "bind_session", providerSessionId: "session-2" }],
    ])
  })

  test("session_bound with the resumed session writes nothing", () => {
    expect(step(running, { type: "session_bound", providerSessionId: "session-1" }, idle)).toEqual([running, []])
  })

  test("session_bound compares against the resumed session every time", () => {
    const [after] = step(running, { type: "session_bound", providerSessionId: "session-2" }, idle)
    expect(step(after, { type: "session_bound", providerSessionId: "session-2" }, idle)[1]).toEqual([
      { type: "bind_session", providerSessionId: "session-2" },
    ])
  })

  test("an event that touches no status changes nothing", () => {
    expect(step(awaiting, { type: "text_delta", text: "hi" }, idle)).toEqual([awaiting, []])
  })
})
