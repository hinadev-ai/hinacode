import { describe, expect, test } from "@effect/vitest"
import type { LineComment } from "../stores/drafts.ts"
import { promptWithComments } from "./lineComments.ts"

const comment = (overrides: Partial<LineComment>): LineComment => ({
  id: "c1",
  path: "src/api.ts",
  startLine: 12,
  endLine: 12,
  code: "await fetch(url)",
  body: "retry only on 5xx",
  ...overrides,
})

describe("promptWithComments", () => {
  test("without comments the prompt is the text", () => {
    expect(promptWithComments("hello", [])).toBe("hello")
  })

  test("each comment carries its place, its code and what the user said", () => {
    expect(
      promptWithComments("fix these", [
        comment({}),
        comment({ id: "c2", path: "a.ts", startLine: 3, endLine: 5, code: "a\nb\nc", body: "drop this" }),
      ]),
    ).toBe(
      [
        "fix these",
        "",
        "Comments on lines of the workspace:",
        "",
        "src/api.ts:12",
        "```",
        "await fetch(url)",
        "```",
        "retry only on 5xx",
        "",
        "a.ts:3-5",
        "```",
        "a\nb\nc",
        "```",
        "drop this",
      ].join("\n"),
    )
  })

  test("comments alone make a prompt", () => {
    expect(promptWithComments("  ", [comment({})])).toMatch(/^Comments on lines of the workspace:\n/)
  })

  test("code with backticks cannot close its fence", () => {
    expect(promptWithComments("", [comment({ code: "const s = ```x```" })])).toContain("````\nconst s = ```x```\n````")
  })
})
