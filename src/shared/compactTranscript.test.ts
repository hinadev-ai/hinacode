import { describe, expect, test } from "@effect/vitest"
import type { Message } from "./domain.ts"
import { compactMessage } from "./compactTranscript.ts"

const message = (parts: Message["parts"]): Message => ({
  id: "m",
  threadId: "t",
  role: "assistant",
  parts,
  createdAt: "2026-10-18T00:00:00.000Z",
  completedAt: null,
  usage: null,
})

describe("compactMessage", () => {
  test("drops tool outputs and file diffs and keeps everything the transcript shows", () => {
    const compact = compactMessage(
      message([
        { type: "text", text: "Done." },
        { type: "tool_call", callId: "c", name: "Bash", input: { command: "ls" }, output: "a\nb", status: "done" },
        { type: "file_change", path: "a.ts", diff: "@@ -1 +1 @@" },
      ]),
    )
    expect(compact.parts).toStrictEqual([
      { type: "text", text: "Done." },
      { type: "tool_call", callId: "c", name: "Bash", input: { command: "ls" }, status: "done" },
      { type: "file_change", path: "a.ts", diff: "" },
    ])
  })

  test("returns parts that are already compact unchanged", () => {
    const tool = { type: "tool_call", callId: "c", name: "Read", input: {}, status: "running" } as const
    expect(compactMessage(message([tool])).parts[0]).toBe(tool)
  })
})
