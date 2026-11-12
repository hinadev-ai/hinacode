import { expect, it } from "vitest"
import { mockSubagents } from "./subagents.ts"

it("stops a running mock sub-agent without its report", () => {
  const { stop } = mockSubagents(0)
  expect(stop("mock-agent-composer", 1000)).toMatchObject([
    { type: "tool_call_finished", output: "Stopped before it finished.", isError: false },
    { type: "subagent_updated", subagent: { status: "stopped", summary: null } },
  ])
})
