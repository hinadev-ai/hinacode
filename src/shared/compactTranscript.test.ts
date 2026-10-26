import { describe, expect, test } from "@effect/vitest"
import type { Message } from "./domain.ts"
import { compactMessage, toolSummary } from "./compactTranscript.ts"

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
  test("keeps each tool call's summary line and drops outputs and file diffs", () => {
    const compact = compactMessage(
      message([
        { type: "text", text: "Done." },
        {
          type: "tool_call",
          callId: "c",
          name: "Bash",
          input: { command: "cat <<EOF\nlong\nEOF", description: "Write a file" },
          output: "a\nb",
          status: "done",
        },
        {
          type: "tool_call",
          callId: "w",
          name: "Write",
          input: { file_path: "a.ts", content: "x" },
          status: "running",
        },
        { type: "tool_call", callId: "t", name: "TodoWrite", input: { todos: [] }, status: "done" },
        { type: "file_change", path: "a.ts", diff: "@@ -1 +1 @@" },
      ]),
    )
    expect(compact.parts).toStrictEqual([
      { type: "text", text: "Done." },
      { type: "tool_call", callId: "c", name: "Bash", input: { command: "cat <<EOF" }, status: "done" },
      { type: "tool_call", callId: "w", name: "Write", input: { file_path: "a.ts" }, status: "running" },
      { type: "tool_call", callId: "t", name: "TodoWrite", input: {}, status: "done" },
      { type: "file_change", path: "a.ts", diff: "" },
    ])
  })

  test("leaves out the calls a sub-agent made", () => {
    const compact = compactMessage(
      message([
        { type: "tool_call", callId: "agent", name: "Agent", input: { description: "Explore" }, status: "done" },
        { type: "tool_call", callId: "c", name: "Read", input: {}, status: "done", parentCallId: "agent" },
      ]),
    )
    expect(compact.parts.map((part) => part.type === "tool_call" && part.callId)).toStrictEqual(["agent"])
  })
})

describe("toolSummary", () => {
  test("reads the first field that names what the call touched", () => {
    expect(toolSummary({ description: "List", command: "ls\n-la" })).toStrictEqual({ key: "command", line: "ls" })
    expect(toolSummary({ todos: [] })).toBeNull()
    expect(toolSummary("raw")).toBeNull()
  })
})

