import { describe, expect, it } from "vitest"
import type { AgentEvent } from "@shared/agent.ts"
import { threadAlert } from "./thread-alerts"

const approval: AgentEvent = {
  type: "approval_requested",
  request: { id: "a1", threadId: "t1", provider: "claude", kind: "command", title: "Run tests", detail: "pnpm test" },
}
const question: AgentEvent = {
  type: "question_requested",
  request: { id: "q1", threadId: "t1", provider: "claude", questions: [] },
}
const secret: AgentEvent = {
  type: "secret_requested",
  request: { id: "s1", threadId: "t1", name: "NPM_TOKEN", description: "Publish the package" },
}

describe("threadAlert", () => {
  it.each<[string, AgentEvent, ReturnType<typeof threadAlert>]>([
    ["a finished turn", { type: "turn_completed" }, { kind: "completed", body: "Finished" }],
    ["an approval", approval, { kind: "needsInput", body: "Waiting for your approval" }],
    ["a question", question, { kind: "needsInput", body: "Waiting for your answer" }],
    ["a secret", secret, { kind: "needsInput", body: "Waiting for a secret" }],
    ["a failure", { type: "turn_failed", message: "Network error" }, { kind: "failed", body: "Failed: Network error" }],
    [
      "a usage limit",
      { type: "turn_limited", limit: { kind: "org_spend", message: "Spend limit reached" } },
      { kind: "failed", body: "Stopped at the usage limit" },
    ],
  ])("raises a notice for %s", (_, event, expected) => {
    expect(threadAlert(event)).toEqual(expected)
  })

  it("keeps only the first line of a failure", () => {
    expect(threadAlert({ type: "turn_failed", message: "Process exited\n  at spawn\n  at run" })).toEqual({
      kind: "failed",
      body: "Failed: Process exited",
    })
  })

  it.each<AgentEvent>([
    { type: "text_delta", text: "Hello" },
    { type: "approval_resolved", requestId: "a1" },
    { type: "question_resolved", requestId: "q1" },
    { type: "secret_resolved", requestId: "s1" },
    { type: "session_bound", providerSessionId: "p1" },
  ])("raises nothing for $type", (event) => {
    expect(threadAlert(event)).toBeNull()
  })
})
