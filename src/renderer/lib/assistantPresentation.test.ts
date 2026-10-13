import { expect, test } from "@effect/vitest"
import type { Message, MessagePart } from "../../shared/domain.ts"
import { assistantPresentation, formatWorkDuration } from "./assistantPresentation.ts"

const message = (
  parts: ReadonlyArray<MessagePart>,
  completedAt: string | null = "2026-10-12T00:08:05.000Z",
): Message => ({
  id: "response",
  threadId: "thread",
  role: "assistant",
  parts,
  createdAt: "2026-10-12T00:00:00.000Z",
  completedAt,
  usage: null,
})

const tool: MessagePart = {
  type: "tool_call",
  callId: "command",
  name: "Bash",
  input: { command: "pwd" },
  output: "/tmp/worked",
  status: "done",
}

test("completed work contains progress and activity while the trailing answer stays visible", () => {
  const parts: ReadonlyArray<MessagePart> = [
    { type: "text", text: "Checking the repository." },
    { type: "reasoning", text: "Inspect the working directory first." },
    tool,
    { type: "text", text: "One file remains." },
    { type: "file_change", path: "README.md", diff: "+Done" },
    { type: "text", text: "The finished answer." },
    { type: "text", text: "More final details." },
  ]
  expect(assistantPresentation(message(parts))).toEqual({
    kind: "completed",
    durationMs: 485_000,
    work: parts.slice(0, 5).map((part, index) => ({ part, index })),
    reply: parts.slice(5).map((part, index) => ({ part, index: index + 5 })),
  })
})

test("running responses keep activity inline and retain original indices after filtering subagent calls", () => {
  const parts: ReadonlyArray<MessagePart> = [
    { ...tool, callId: "nested", parentCallId: "agent" },
    tool,
    { type: "text", text: "Still writing." },
  ]
  expect(assistantPresentation(message(parts, null))).toEqual({
    kind: "inline",
    parts: [
      { part: tool, index: 1 },
      { part: parts[2], index: 2 },
    ],
  })
})

test("questions before the last tool remain visible outside completed work", () => {
  const questions: MessagePart = { type: "questions", text: "Which approach?", questions: [] }
  const presentation = assistantPresentation(message([questions, tool, { type: "text", text: "Choose a path." }]))
  expect(presentation.kind).toBe("completed")
  if (presentation.kind !== "completed") throw new Error("Expected completed work")
  expect(presentation.work).toEqual([{ part: tool, index: 1 }])
  expect(presentation.reply).toEqual([
    { part: questions, index: 0 },
    { part: { type: "text", text: "Choose a path." }, index: 2 },
  ])
})

test("text-only and tool-only completions have a duration without inventing an answer or work", () => {
  const text: MessagePart = { type: "text", text: "Hello." }
  expect(assistantPresentation(message([text]))).toEqual({
    kind: "completed",
    durationMs: 485_000,
    work: [],
    reply: [{ part: text, index: 0 }],
  })
  expect(assistantPresentation(message([tool]))).toEqual({
    kind: "completed",
    durationMs: 485_000,
    work: [{ part: tool, index: 0 }],
    reply: [],
  })
})

test("synthetic subagent transcripts and user messages keep their inline presentation", () => {
  const response = message([tool])
  expect(assistantPresentation(response, false)).toEqual({ kind: "inline", parts: [{ part: tool, index: 0 }] })
  expect(assistantPresentation({ ...response, role: "user" }).kind).toBe("inline")
})

test("invalid or reversed timestamps never produce a misleading elapsed duration", () => {
  for (const completedAt of ["invalid", "2026-10-11T00:00:00.000Z"]) {
    expect(assistantPresentation(message([tool], completedAt)).kind).toBe("inline")
  }
  expect(assistantPresentation({ ...message([tool]), createdAt: "invalid" }).kind).toBe("inline")
})

test("duration belongs to each steered response segment", () => {
  const beforeSteer = message([tool], "2026-10-12T00:02:00.000Z")
  const afterSteer = { ...message([tool]), createdAt: beforeSteer.completedAt ?? "" }
  expect(assistantPresentation(beforeSteer)).toMatchObject({ kind: "completed", durationMs: 120_000 })
  expect(assistantPresentation(afterSteer)).toMatchObject({ kind: "completed", durationMs: 365_000 })
})

test("formats whole elapsed seconds as mm:ss or h:mm:ss", () => {
  for (const [ms, expected] of [
    [0, "00:00"],
    [999, "00:00"],
    [1_999, "00:01"],
    [59_000, "00:59"],
    [60_000, "01:00"],
    [485_000, "08:05"],
    [3_599_999, "59:59"],
    [3_600_000, "1:00:00"],
    [3_723_000, "1:02:03"],
    [-1_000, "00:00"],
  ] as const) {
    expect(formatWorkDuration(ms)).toBe(expected)
  }
})
