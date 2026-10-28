import { expect, test } from "@effect/vitest"
import type { Message, MessagePart } from "../../shared/domain.ts"
import { findMatches } from "./find.ts"

const message = (id: string, parts: ReadonlyArray<MessagePart>, completedAt: string | null = "done"): Message => ({
  id,
  threadId: "t1",
  role: "assistant",
  parts,
  createdAt: "2026-10-12T00:00:00.000Z",
  completedAt,
  usage: null,
  forkPoint: null,
})

test("finds every case-insensitive occurrence in reading order", () => {
  const messages = [
    message("m1", [{ type: "text", text: "Run the Migration, then the migration test" }]),
    message("m2", [{ type: "text", text: "nothing here" }]),
    message("m3", [
      { type: "text", text: "intro" },
      { type: "text", text: "MIGRATION done" },
    ]),
  ]
  expect(findMatches(messages, "migration")).toEqual([
    { messageId: "m1", partIndex: 0, offset: 8 },
    { messageId: "m1", partIndex: 0, offset: 28 },
    { messageId: "m3", partIndex: 1, offset: 0 },
  ])
})

test("treats the query as literal text, not a pattern", () => {
  const messages = [message("m1", [{ type: "text", text: "a.b axb (x) [y]" }])]
  expect(findMatches(messages, "a.b")).toHaveLength(1)
  expect(findMatches(messages, "(x)")).toEqual([{ messageId: "m1", partIndex: 0, offset: 8 }])
})

test("a blank query matches nothing", () => {
  const messages = [message("m1", [{ type: "text", text: "   " }])]
  expect(findMatches(messages, "")).toEqual([])
  expect(findMatches(messages, "  ")).toEqual([])
})

test("searches what the collapsed transcript shows and skips what sits behind a disclosure", () => {
  const messages = [
    message("m1", [
      { type: "reasoning", text: "migrate first" },
      {
        type: "tool_call",
        callId: "c1",
        name: "Bash",
        input: { command: "pnpm migrate" },
        output: "migrate ok",
        status: "done",
      },
      { type: "file_change", path: "src/db/migrate.ts", diff: "+migrate" },
    ]),
  ]
  expect(findMatches(messages, "migrate")).toEqual([
    { messageId: "m1", partIndex: 1, offset: 10 },
    { messageId: "m1", partIndex: 2, offset: 7 },
  ])
})

test("skips reply text the agent is still writing", () => {
  const messages = [
    message(
      "m1",
      [
        { type: "text", text: "first migration" },
        { type: "tool_call", callId: "c1", name: "Bash", input: { command: "ls" }, status: "done" },
        { type: "text", text: "migration in progress" },
      ],
      null,
    ),
  ]
  expect(findMatches(messages, "migration")).toEqual([{ messageId: "m1", partIndex: 0, offset: 6 }])
})

test("finds a posted question's transcript text after the user answers", () => {
  const messages = [
    message("question", [{ type: "questions", text: "Which color?", questions: [] }]),
    { ...message("answer", [{ type: "text", text: "Blue" }]), role: "user" as const },
  ]
  expect(findMatches(messages, "color")).toEqual([{ messageId: "question", partIndex: 0, offset: 6 }])
})

test("follows the original order of questions, progress, and the final answer", () => {
  const messages = [
    message(
      "m1",
      [
        { type: "questions", text: "Which migration?", questions: [] },
        { type: "text", text: "Checking migration." },
        { type: "tool_call", callId: "c1", name: "Bash", input: { command: "pnpm migrate" }, status: "done" },
        { type: "text", text: "Migration finished." },
      ],
      "2026-10-12T00:08:05.000Z",
    ),
  ]
  expect(findMatches(messages, "migration")).toEqual([
    { messageId: "m1", partIndex: 0, offset: 6 },
    { messageId: "m1", partIndex: 1, offset: 9 },
    { messageId: "m1", partIndex: 3, offset: 0 },
  ])
})

test("searches every call folded into a run, by its command or by its tool name and summary", () => {
  const bash: MessagePart = {
    type: "tool_call",
    callId: "c",
    name: "Bash",
    input: { command: "cat a.ts" },
    status: "done",
  }
  const read: MessagePart = {
    type: "tool_call",
    callId: "r",
    name: "Read",
    input: { file_path: "a.ts" },
    status: "done",
  }
  expect(findMatches([message("m", [bash, read])], "a.ts")).toEqual([
    { messageId: "m", partIndex: 0, offset: 4 },
    { messageId: "m", partIndex: 1, offset: 5 },
  ])
})
