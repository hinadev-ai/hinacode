import { describe, expect, test } from "@effect/vitest"
import type { AgentEvent } from "./agent.ts"
import type { Message, MessagePart } from "./domain.ts"
import {
  compactMessage,
  compactPush,
  previewMessage,
  publishPreview,
  previewPush,
  TOOL_OUTPUT_PREVIEW_CHARS,
  TRANSCRIPT_PAGE_BYTES,
  toolSummary,
  transcriptPage,
} from "./compactTranscript.ts"
import { OUTLINE_MAX_BLOCKS } from "./documentOutline.ts"
import { foldEvent } from "./foldEvent.ts"
import { latestTodos } from "./todos.ts"

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
        { type: "tool_call", callId: "t", name: "ExitPlanMode", input: { plan: "Ship it" }, status: "done" },
        { type: "file_change", path: "a.ts", diff: "@@ -1 +1 @@" },
      ]),
    )
    expect(compact.parts).toStrictEqual([
      { type: "text", text: "Done." },
      { type: "tool_call", callId: "c", name: "Bash", input: { command: "cat <<EOF" }, status: "done" },
      { type: "tool_call", callId: "w", name: "Write", input: { file_path: "a.ts" }, status: "running" },
      { type: "tool_call", callId: "t", name: "ExitPlanMode", input: {}, status: "done" },
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

  test("keeps the input of the calls a task list is read from", () => {
    const parts: Message["parts"] = [
      {
        type: "tool_call",
        callId: "create",
        name: "TaskCreate",
        input: { subject: "Read README.md", description: "Read README.md in the working directory" },
        output: "Task #1 created successfully: Read README.md",
        status: "done",
      },
      {
        type: "tool_call",
        callId: "update",
        name: "TaskUpdate",
        input: { taskId: "1", status: "completed" },
        status: "done",
      },
    ]
    expect(latestTodos([compactMessage(message(parts))])).toStrictEqual([
      { text: "Read README.md", status: "completed" },
    ])
  })

  test("keeps the id a created task reports, so a later update finds it", () => {
    const parts: Message["parts"] = [
      {
        type: "tool_call",
        callId: "create",
        name: "TaskCreate",
        input: { subject: "Ship it" },
        output: "Task #7 created successfully: Ship it",
        status: "done",
      },
      {
        type: "tool_call",
        callId: "update",
        name: "TaskUpdate",
        input: { taskId: "7", status: "completed" },
        status: "done",
      },
    ]
    expect(latestTodos([compactMessage(message(parts))])).toStrictEqual([{ text: "Ship it", status: "completed" }])
    const finished = compactPush({
      type: "thread.event",
      threadId: "t",
      messageId: "m",
      event: {
        type: "tool_call_finished",
        callId: "create",
        output: "Task #7 created successfully: Ship it",
        isError: false,
      },
    } as never)
    expect((finished as { event: { output: unknown } }).event.output).toBe("Task #7 created successfully: Ship it")
  })
})

describe("toolSummary", () => {
  test("reads the first field that names what the call touched", () => {
    expect(toolSummary({ description: "List", command: "ls\n-la" })).toStrictEqual({ key: "command", line: "ls" })
    expect(toolSummary({ todos: [] })).toBeNull()
    expect(toolSummary("raw")).toBeNull()
  })

  test("names the same subject the desktop does", () => {
    expect(toolSummary({ query: "effect schema" })).toStrictEqual({ key: "query", line: "effect schema" })
    expect(toolSummary({ notebook_path: "a.ipynb" })).toStrictEqual({ key: "notebook_path", line: "a.ipynb" })
    expect(toolSummary({ path: "src", pattern: "TODO" })).toStrictEqual({ key: "pattern", line: "TODO" })
  })
})

describe("a compact transcript", () => {
  const events: ReadonlyArray<AgentEvent> = [
    { type: "tool_call_started", callId: "agent", name: "Agent", input: { description: "Explore" } },
    { type: "tool_call_started", callId: "read", name: "Read", input: { file_path: "a.ts" }, parentCallId: "agent" },
    { type: "tool_call_finished", callId: "read", output: "x", isError: false },
    { type: "tool_call_finished", callId: "agent", output: "found it", isError: false },
    { type: "tool_call_started", callId: "search", name: "WebSearch", input: { query: "effect schema" } },
    { type: "tool_call_finished", callId: "search", output: "results", isError: false },
  ]
  const fold = (events: ReadonlyArray<AgentEvent>) =>
    events.reduce((folded, event) => foldEvent(folded, event, "2026-10-18T00:00:00.000Z"), message([]))
  const calls = (folded: Message) =>
    folded.parts.flatMap((part) => (part.type === "tool_call" ? [{ callId: part.callId, input: part.input }] : []))
  const pushed = events.map((event, seq) => compactPush({ type: "thread.event", seq, threadId: "t", event }))
  const live = pushed.flatMap((push) => (push.type === "thread.event" ? [push.event as AgentEvent] : []))

  test("shows the same calls live as after reload", () => {
    expect(calls(fold(live))).toStrictEqual(calls(compactMessage(fold(events))))
    expect(calls(fold(live))).toStrictEqual([
      { callId: "agent", input: { description: "Explore" } },
      { callId: "search", input: { query: "effect schema" } },
    ])
  })

  test("sends the phone nothing about a sub-agent's calls", () => {
    expect(live.filter((event) => "callId" in event && event.callId === "read")).toStrictEqual([])
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

const compacted = (part: MessagePart) =>
  compactMessage(message([part])).parts[0] as Extract<MessagePart, { type: "tool_call" }>
const finished = (output: unknown, isError = false) =>
  compactPush({
    type: "thread.event",
    seq: 1,
    threadId: "t",
    event: { type: "tool_call_finished", callId: "c", output, isError },
  })

describe("a publish call when compact", () => {
  const document = `# Release plan\n\n> [!NOTE]\n> Ship on Friday.\n\n## Goal\n\n${"Words go here. ".repeat(70_000)}\n`
  const publishedLine =
    'Published document doc-1 version 3: "Release plan". To update it, pass id "doc-1" and revision 4.'
  const publish = (overrides: Partial<Extract<MessagePart, { type: "tool_call" }>> = {}): MessagePart => ({
    type: "tool_call",
    callId: "c",
    name: "mcp__hinacode__publish_document",
    input: { title: "Release plan", markdown: document, auto_open: true },
    output: publishedLine,
    status: "done",
    ...overrides,
  })
  test("keeps the title and outline and never the Markdown", () => {
    const part = compacted(publish())
    expect(part.input).toEqual({
      title: "Release plan",
      outline: {
        title: "Release plan",
        lede: "Ship on Friday.",
        blocks: [
          { kind: "heading", level: 1, text: "Release plan" },
          { kind: "callout", tone: "note" },
          { kind: "heading", level: 2, text: "Goal" },
          { kind: "text", length: 2048 },
        ],
      },
    })
    expect(JSON.stringify(part).includes("Words go here")).toBe(false)
  })

  test("fits a page, however large the document", () => {
    const heading = "## 見出し\n\n".repeat(OUTLINE_MAX_BLOCKS)
    const part = compacted(
      publish({ input: { title: "標".repeat(100_000), markdown: `${heading}${"x".repeat(1 << 20)}` } }),
    )
    expect(new TextEncoder().encode(JSON.stringify(part)).length).toBeLessThan(TRANSCRIPT_PAGE_BYTES / 8)
  })

  test("keeps a page's title and none of its files", () => {
    const part = compacted(
      publish({
        name: "publish_artifact",
        input: { id: "page-1", title: "Report", files: [{ path: "index.html", content: "<h1>Hi</h1>" }] },
      }),
    )
    expect(part.input).toEqual({ title: "Report" })
  })

  test("keeps only the first line of a successful publish, also from structured output", () => {
    const report = `${publishedLine}\n\nThe page's inspection report.`
    const blocks = [
      { type: "text", text: report },
      { type: "image", data: "aaaa", mimeType: "image/png" },
    ]
    expect(compacted(publish({ output: report })).output).toBe(publishedLine)
    expect(compacted(publish({ output: blocks })).output).toBe(publishedLine)
    expect(finished(report)).toMatchObject({ event: { output: publishedLine } })
    expect(finished(blocks)).toMatchObject({ event: { output: publishedLine } })
  })

  test("keeps the first line of a publish from Codex, which wraps the blocks in content", () => {
    const codexResult = { content: [{ type: "text", text: `${publishedLine}\n\nMore.` }], structuredContent: null }
    expect(compacted(publish({ output: codexResult })).output).toBe(publishedLine)
    expect(finished(codexResult)).toMatchObject({ event: { output: publishedLine } })
  })

  test("drops the document a conflict carries", () => {
    const conflict = "The developer edited document doc-1 after your revision 3.\n\n# Their whole document"
    expect(compacted(publish({ output: conflict, status: "error" })).output).toBeUndefined()
    expect(finished(conflict, true)).toMatchObject({ event: { output: "" } })
  })

  test("drops a failed publish's output even when it reads like a success", () => {
    expect(compacted(publish({ status: "error" })).output).toBeUndefined()
    expect(finished(publishedLine, true)).toMatchObject({ event: { output: "" } })
  })

  test("sends a running publish no output", () => {
    const { output: _output, ...running } = publish({ status: "running" }) as Extract<
      MessagePart,
      { type: "tool_call" }
    >
    expect(compacted(running).output).toBeUndefined()
    const started = compactPush({
      type: "thread.event",
      seq: 1,
      threadId: "t",
      event: {
        type: "tool_call_started",
        callId: "c",
        name: "mcp__hinacode__publish_document",
        input: { title: "Release plan", markdown: document },
      },
    })
    expect(JSON.stringify(started).includes("Words go here")).toBe(false)
    expect(started).toMatchObject({ event: { input: { title: "Release plan", outline: { title: "Release plan" } } } })
  })

  test("reads what an older server sends as nothing, and an older phone sees no summary", () => {
    expect(publishPreview({})).toEqual({ title: null, outline: null })
    expect(publishPreview({ title: "Plan", outline: { blocks: "not an outline" } })).toEqual({
      title: "Plan",
      outline: null,
    })
    const { title, outline } = publishPreview(compacted(publish()).input)
    expect(title).toBe("Release plan")
    expect(outline?.lede).toBe("Ship on Friday.")
    expect(toolSummary(compacted(publish()).input)).toBeNull()
  })

  test("leaves other tools as they were", () => {
    const bash: MessagePart = {
      type: "tool_call",
      callId: "b",
      name: "Bash",
      input: { command: "cat a\nb", title: "Not a publish", markdown: "# Not a document" },
      output: `${publishedLine}\nmore`,
      fullOutputBytes: 9,
      status: "done",
    }
    expect(compactMessage(message([bash])).parts).toEqual([
      { type: "tool_call", callId: "b", name: "Bash", input: { command: "cat a" }, status: "done" },
    ])
    expect(finished("ordinary output")).toEqual({
      type: "thread.event",
      seq: 1,
      threadId: "t",
      event: { type: "tool_call_finished", callId: "c", output: "", isError: false },
    })
  })
})
