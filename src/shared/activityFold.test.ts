import { expect, test } from "@effect/vitest"
import { collapsedParts, isActivity } from "./activityFold.ts"
import type { MessagePart } from "./domain.ts"

const tool: MessagePart = {
  type: "tool_call",
  callId: "command",
  name: "Bash",
  input: { command: "pwd" },
  output: "/tmp/worked",
  status: "done",
}

test("reasoning, tools and file changes are activity, while text, questions and attachments are the reply", () => {
  const reply: ReadonlyArray<MessagePart> = [
    { type: "text", text: "Done." },
    { type: "questions", text: "Which approach?", questions: [] },
  ]
  const activity: ReadonlyArray<MessagePart> = [
    { type: "reasoning", text: "Look first." },
    tool,
    { type: "file_change", path: "README.md", diff: "+Done" },
  ]
  expect(reply.map(isActivity)).toEqual([false, false])
  expect(activity.map(isActivity)).toEqual([true, true, true])
})

test("collapsed responses hide the progress notes written between tool calls and keep the answer", () => {
  const questions: MessagePart = { type: "questions", text: "Which approach?", questions: [] }
  const parts = [
    { type: "reasoning", text: "Find the compact handling." },
    tool,
    { type: "text", text: "Short status: checking each protocol's compact call now." },
    tool,
    questions,
    { type: "text", text: "Now the Codex fix." },
    { type: "file_change", path: "README.md", diff: "+Done" },
    { type: "text", text: "/compact now works on Codex and Muse." },
    { type: "text", text: "Limits: it has to be the whole prompt." },
  ] satisfies ReadonlyArray<MessagePart>
  const indexed = parts.map((part, index) => ({ part, index }))
  expect(collapsedParts(indexed)).toEqual([indexed[4], indexed[7], indexed[8]])
})

test("a collapsed response cut off by a steer keeps the last thing the agent said", () => {
  const parts = [
    { type: "text", text: "Checks passed. Merging the rest of the stack." },
    tool,
    { type: "text", text: "#211 merged. Merging #212 next." },
    tool,
  ] satisfies ReadonlyArray<MessagePart>
  const indexed = parts.map((part, index) => ({ part, index }))
  expect(collapsedParts(indexed)).toEqual([indexed[2]])
})

test("collapsing a response without activity keeps all of it", () => {
  const indexed = [{ part: { type: "text", text: "Hello." } satisfies MessagePart, index: 0 }]
  expect(collapsedParts(indexed)).toEqual(indexed)
})
