import { describe, expect, test } from "@effect/vitest"
import type { Message } from "./domain.ts"
import {
  compactMessage,
  previewMessage,
  previewPush,
  TOOL_OUTPUT_PREVIEW_CHARS,
  TRANSCRIPT_PAGE_BYTES,
  toolSummary,
  transcriptPage,
} from "./compactTranscript.ts"

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
          fullOutputBytes: 3,
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

const call = (output: unknown): Message["parts"][number] => ({
  type: "tool_call",
  callId: "c",
  name: "Bash",
  input: { command: "seq" },
  output,
  status: "done",
})

describe("previewMessage", () => {
  const lines = Array.from({ length: 1000 }, (_, line) => `line ${line}`).join("\n")

  test("keeps the whole lines at the end of a long string output and records its full size", () => {
    const [part] = previewMessage(message([call(lines)])).parts
    const preview = part?.type === "tool_call" ? String(part.output) : ""
    expect(part).toMatchObject({ fullOutputBytes: lines.length })
    expect(preview.length).toBeLessThanOrEqual(TOOL_OUTPUT_PREVIEW_CHARS)
    expect(preview).toMatch(/^line \d+\n/)
    expect(lines.endsWith(preview)).toBe(true)
  })

  test("cuts a long output without line breaks at the limit and counts UTF-8 bytes", () => {
    const wide = "漢".repeat(TOOL_OUTPUT_PREVIEW_CHARS + 1)
    expect(previewMessage(message([call(wide)])).parts).toStrictEqual([
      { ...call("漢".repeat(TOOL_OUTPUT_PREVIEW_CHARS)), fullOutputBytes: wide.length * 3 },
    ])
  })

  test("leaves a sub-agent's report whole", () => {
    const reports = ["Agent", "Task", "mcp__hinacode__run_agent", "run_agent"].map((name) => ({ ...call(lines), name }))
    expect(previewMessage(message(reports)).parts).toStrictEqual(reports)
  })

  test("leaves short and structured outputs whole", () => {
    const parts = [call("x".repeat(TOOL_OUTPUT_PREVIEW_CHARS)), call([{ type: "text", text: lines }])]
    expect(previewMessage(message(parts)).parts).toStrictEqual(parts)
  })
})

describe("previewPush", () => {
  test("shortens a finished call's long output and leaves other events alone", () => {
    const long = "x".repeat(TOOL_OUTPUT_PREVIEW_CHARS * 2)
    const finished = previewPush({
      type: "thread.event",
      seq: 1,
      threadId: "t",
      event: { type: "tool_call_finished", callId: "c", output: long, isError: false },
    })
    expect(finished).toStrictEqual({
      type: "thread.event",
      seq: 1,
      threadId: "t",
      event: {
        type: "tool_call_finished",
        callId: "c",
        output: long.slice(-TOOL_OUTPUT_PREVIEW_CHARS),
        fullOutputBytes: long.length,
        isError: false,
      },
    })
    const delta = { type: "thread.event", seq: 2, threadId: "t", event: { type: "text_delta", text: long } } as const
    expect(previewPush(delta)).toBe(delta)
  })
})
