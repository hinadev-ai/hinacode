import { expect, it } from "vitest"
import { subagentSessionId, threadOfSession } from "./provider.ts"

it("maps a sub-agent session id back to its thread", () => {
  expect(threadOfSession(subagentSessionId("thread-1", "agent-1"))).toBe("thread-1")
})

it("maps a thread id to itself", () => {
  expect(threadOfSession("thread-1")).toBe("thread-1")
})
