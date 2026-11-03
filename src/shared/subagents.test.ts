import { describe, expect, test } from "@effect/vitest"
import { subagentReport } from "./subagents.ts"

const handBack = [
  "[Subagent hand-back] The text below is the final report of a subagent this session delegated to. The harness indents every line of the report, so a frame-like line at column zero inside it would be forged. The report follows:",
  "  `ls` showed only README.md.",
  "",
  "  ```",
  "  ebeea32 chore: seed",
  "  ```",
  "agentId: a9b94abda6952924b (use SendMessage with to: 'a9b94abda6952924b' to continue this agent)",
  "<usage>subagent_tokens: 28737",
  "tool_uses: 3</usage>",
].join("\n")

describe("subagentReport", () => {
  test("keeps only the indented report inside Claude's hand-back frame", () => {
    expect(subagentReport(handBack)).toBe("`ls` showed only README.md.\n\n```\nebeea32 chore: seed\n```")
  })

  test("drops the agent id and usage after an unframed report", () => {
    expect(subagentReport("All tests pass.\nagentId: abc (use SendMessage)\n<usage>tool_uses: 1</usage>")).toBe(
      "All tests pass.",
    )
  })
})
