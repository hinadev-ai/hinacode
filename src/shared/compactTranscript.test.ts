import { describe, expect, test } from "@effect/vitest"
import type { Message } from "./domain.ts"
import { compactMessage, TRANSCRIPT_PAGE_BYTES, toolSummary, transcriptPage } from "./compactTranscript.ts"

const message = (parts: Message["parts"]): Message => ({
  id: "m",
  threadId: "t",
  role: "assistant",
  parts,
  createdAt: "2026-10-18T00:00:00.000Z",
  completedAt: null,
  usage: null,
  forkPoint: null,
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

const sized = (id: string, chars: number, char = "x"): Message => ({
  ...message([{ type: "text", text: char.repeat(chars) }]),
  id,
})
const ids = (page: { messages: ReadonlyArray<Message> }) => page.messages.map((m) => m.id)
const utf8Bytes = (messages: ReadonlyArray<Message>) => new TextEncoder().encode(JSON.stringify(messages)).length

describe("transcriptPage", () => {
  const transcript = ["a", "b", "c", "d"].map((id) => sized(id, 400))
  const two = utf8Bytes(transcript.slice(2))

  test("takes the newest messages that fit and says older ones remain", () => {
    const page = transcriptPage(transcript, undefined, two)
    expect(ids(page)).toStrictEqual(["c", "d"])
    expect(page.hasEarlier).toBe(true)
  })

  test("counts the array's brackets and commas", () => {
    expect(ids(transcriptPage(transcript, undefined, two - 1))).toStrictEqual(["d"])
  })

  test("continues before a message, down to the first", () => {
    expect(ids(transcriptPage(transcript, "c", two))).toStrictEqual(["a", "b"])
    expect(transcriptPage(transcript, "c", two).hasEarlier).toBe(false)
    expect(transcriptPage(transcript, "a", two)).toStrictEqual({ messages: [], hasEarlier: false })
  })

  test.each([
    ["CJK", "漢"],
    ["emoji", "😀"],
  ])("fits a page of %s text in the budget by its UTF-8 bytes", (_name, char) => {
    const wide = ["a", "b", "c", "d", "e", "f", "g"].map((id) => sized(id, 10_000, char))
    const page = transcriptPage(wide, undefined)
    expect(utf8Bytes(page.messages)).toBeLessThanOrEqual(TRANSCRIPT_PAGE_BYTES)
    expect(utf8Bytes(wide.slice(-page.messages.length - 1))).toBeGreaterThan(TRANSCRIPT_PAGE_BYTES)
    expect(page.hasEarlier).toBe(true)
  })

  test("always returns one message, however large", () => {
    expect(ids(transcriptPage([...transcript, sized("huge", 30_000, "😀")], undefined))).toStrictEqual(["huge"])
  })

  test("an unknown message gives an empty page", () => {
    expect(transcriptPage(transcript, "gone")).toStrictEqual({ messages: [], hasEarlier: false })
  })
})
