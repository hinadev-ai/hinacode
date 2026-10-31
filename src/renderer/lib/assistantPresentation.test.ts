import { expect, test } from "@effect/vitest"
import type { Message, MessagePart } from "../../shared/domain.ts"
import { assistantPresentation, foldedParts, formatWorkDuration, INLINE_TAIL_PARTS } from "./assistantPresentation.ts"

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
  forkPoint: null,
})

const tool: MessagePart = {
  type: "tool_call",
  callId: "command",
  name: "Bash",
  input: { command: "pwd" },
  output: "/tmp/worked",
  status: "done",
}

test("completed responses retain activity and the answer in their original order", () => {
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
    parts: parts.map((part, index) => ({ part, index })),
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

test("questions retain their original position before a tool", () => {
  const questions: MessagePart = { type: "questions", text: "Which approach?", questions: [] }
  const presentation = assistantPresentation(message([questions, tool, { type: "text", text: "Choose a path." }]))
  expect(presentation.kind).toBe("completed")
  if (presentation.kind !== "completed") throw new Error("Expected completed work")
  expect(presentation.parts).toEqual([
    { part: questions, index: 0 },
    { part: tool, index: 1 },
    { part: { type: "text", text: "Choose a path." }, index: 2 },
  ])
})

test("text-only and tool-only completions keep their parts alongside the duration", () => {
  const text: MessagePart = { type: "text", text: "Hello." }
  expect(assistantPresentation(message([text]))).toEqual({
    kind: "completed",
    durationMs: 485_000,
    parts: [{ part: text, index: 0 }],
  })
  expect(assistantPresentation(message([tool]))).toEqual({
    kind: "completed",
    durationMs: 485_000,
    parts: [{ part: tool, index: 0 }],
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

test("long running responses fold everything before their latest parts", () => {
  const parts = Array.from({ length: INLINE_TAIL_PARTS + 3 }, (_, index) => ({ ...tool, callId: `call-${index}` }))
  const presentation = assistantPresentation(message(parts, null))
  expect(foldedParts(presentation)).toEqual(presentation.parts.slice(3))
  expect(foldedParts(assistantPresentation(message(parts.slice(0, 2), null)))).toHaveLength(2)
})

test("completed responses fold their activity and keep the answer", () => {
  const answer: MessagePart = { type: "text", text: "Done." }
  expect(foldedParts(assistantPresentation(message([tool, answer])))).toEqual([{ part: answer, index: 1 }])
})

test("formats short turns in seconds and longer turns as m:ss or h:mm:ss", () => {
  for (const [ms, expected] of [
    [0, "<1s"],
    [999, "<1s"],
    [1_000, "1s"],
    [4_200, "4s"],
    [59_999, "59s"],
    [60_000, "1:00"],
    [485_000, "8:05"],
    [3_599_999, "59:59"],
    [3_600_000, "1:00:00"],
    [3_723_000, "1:02:03"],
    [-1_000, "<1s"],
    [Number.NaN, "<1s"],
  ] as const) {
    expect(formatWorkDuration(ms)).toBe(expected)
  }
})

test("an agent switch stays inline without a Worked for row", () => {
  const parts: ReadonlyArray<MessagePart> = [{ type: "agent_switch", from: "claude", to: "codex" }]
  expect(assistantPresentation(message(parts, "2026-10-12T00:00:00.000Z"))).toEqual({
    kind: "inline",
    parts: [{ part: parts[0], index: 0 }],
  })
})
