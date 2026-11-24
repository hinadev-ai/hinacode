import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import type { AgentEvent } from "../../../shared/agent.ts"
import { makeEventMapper } from "./events.ts"

const recorded = readFileSync(join(import.meta.dirname, "fixtures", "live-turn.jsonl"), "utf8")
  .split("\n")
  .filter(Boolean)
  .map((line): unknown => JSON.parse(line))

const textOf = (events: ReadonlyArray<AgentEvent>, type: "text_delta" | "reasoning_delta") =>
  events.flatMap((event) => (event.type === type ? [event.text] : [])).join("")

describe("makeEventMapper", () => {
  it("maps a turn recorded from pi 1.5.2 that reads, edits and runs a command", () => {
    const mapper = makeEventMapper("/work")
    const events = recorded.flatMap((event) => mapper.apply(event))

    expect(textOf(events, "text_delta")).toBe("DONE")
    expect(textOf(events, "reasoning_delta")).toMatch(/^The user wants me to:\n1\. Edit a\.txt/)
    expect(events.filter((event) => event.type !== "text_delta" && event.type !== "reasoning_delta")).toStrictEqual([
      {
        type: "tool_call_started",
        callId: "toolu_015q911EQ2iYVaiLaTTZZmx6",
        name: "Read",
        input: { path: "a.txt", file_path: "/work/a.txt" },
      },
      { type: "tool_call_finished", callId: "toolu_015q911EQ2iYVaiLaTTZZmx6", output: "hello\n", isError: false },
      {
        type: "tool_call_started",
        callId: "toolu_014J3Dvpjh5LmkA3kqFpo6Lu",
        name: "Edit",
        input: { path: "a.txt", edits: [{ oldText: "hello", newText: "goodbye" }], file_path: "/work/a.txt" },
      },
      {
        type: "tool_call_finished",
        callId: "toolu_014J3Dvpjh5LmkA3kqFpo6Lu",
        output: "Successfully replaced 1 block(s) in a.txt.",
        isError: false,
      },
      {
        type: "file_changed",
        path: "/work/a.txt",
        diff: "--- a.txt\n+++ a.txt\n@@ -1,1 +1,1 @@\n-hello\n+goodbye\n",
      },
      {
        type: "tool_call_started",
        callId: "toolu_01ABANb1cLMMeM68hkSL5YPv",
        name: "Bash",
        input: { command: "cat a.txt" },
      },
      { type: "tool_call_finished", callId: "toolu_01ABANb1cLMMeM68hkSL5YPv", output: "goodbye\n", isError: false },
    ])
    expect(mapper.tool("toolu_01ABANb1cLMMeM68hkSL5YPv")).toStrictEqual({
      name: "bash",
      args: { command: "cat a.txt" },
    })
    expect(mapper.settle(false, 200000)).toStrictEqual([
      {
        type: "turn_completed",
        usage: {
          inputTokens: 51677,
          outputTokens: 437,
          costUsd: expect.closeTo(0.02248045, 10),
          context: { usedTokens: 13175, maxTokens: 200000 },
        },
      },
    ])
  })

  it("knows a tool call from its toolcall_end before pi starts running it", () => {
    const mapper = makeEventMapper("/work")
    mapper.apply({
      type: "message_update",
      assistantMessageEvent: {
        type: "toolcall_end",
        toolCall: { type: "toolCall", id: "c1", name: "write", arguments: { path: "/abs/b.txt", content: "x" } },
      },
    })
    expect(mapper.tool("c1")).toStrictEqual({ name: "write", args: { path: "/abs/b.txt", content: "x" } })
  })

  it("names pi's search tools after the ones HinaCode labels, and leaves the rest as they are", () => {
    const mapper = makeEventMapper("/work")
    const started = [
      { toolName: "grep", args: { pattern: "TODO", path: "src" } },
      { toolName: "find", args: { pattern: "*.ts" } },
      { toolName: "ls", args: { path: "." } },
      { toolName: "mcp__hinacode__review_changes", args: {} },
    ].flatMap((call, index) => mapper.apply({ type: "tool_execution_start", toolCallId: `c${index}`, ...call }))
    expect(
      started.map((event) => (event.type === "tool_call_started" ? [event.name, event.input] : null)),
    ).toStrictEqual([
      ["Grep", { pattern: "TODO", path: "src" }],
      ["Glob", { pattern: "*.ts" }],
      ["ls", { path: "." }],
      ["mcp__hinacode__review_changes", {}],
    ])
  })

  it("keeps the images a tool returns, and reports no file change for a failed edit", () => {
    const mapper = makeEventMapper("/work")
    mapper.apply({ type: "tool_execution_start", toolCallId: "r", toolName: "read", args: { path: "shot.png" } })
    mapper.apply({ type: "tool_execution_start", toolCallId: "e", toolName: "edit", args: { path: "a.txt" } })
    const read = mapper.apply({
      type: "tool_execution_end",
      toolCallId: "r",
      toolName: "read",
      result: {
        content: [
          { type: "text", text: "Read image" },
          { type: "image", data: "AAAA", mimeType: "image/png" },
        ],
      },
      isError: false,
    })
    expect(read).toStrictEqual([
      {
        type: "tool_call_finished",
        callId: "r",
        output: [
          { type: "text", text: "Read image" },
          { type: "image", data: "AAAA", mimeType: "image/png" },
        ],
        isError: false,
      },
    ])
    const edit = mapper.apply({
      type: "tool_execution_end",
      toolCallId: "e",
      toolName: "edit",
      result: { content: [{ type: "text", text: "Could not find the text" }] },
      isError: true,
    })
    expect(edit).toStrictEqual([
      { type: "tool_call_finished", callId: "e", output: "Could not find the text", isError: true },
    ])
  })

  it("maps compaction", () => {
    const mapper = makeEventMapper("/work")
    expect(mapper.apply({ type: "compaction_start", reason: "threshold" })).toStrictEqual([
      { type: "compaction_updated", compaction: { status: "running" } },
    ])
    expect(
      mapper.apply({
        type: "compaction_end",
        reason: "threshold",
        result: { summary: "s", tokensBefore: 150000, estimatedTokensAfter: 20000 },
        aborted: false,
        willRetry: false,
      }),
    ).toStrictEqual([
      {
        type: "compaction_updated",
        compaction: { status: "done", trigger: "auto", preTokens: 150000, postTokens: 20000 },
      },
    ])
    expect(
      mapper.apply({
        type: "compaction_end",
        reason: "manual",
        aborted: false,
        willRetry: false,
        errorMessage: "Compaction failed: no model",
      }),
    ).toStrictEqual([
      { type: "compaction_updated", compaction: { status: "failed", message: "Compaction failed: no model" } },
    ])
  })

  it("fails a turn whose last assistant message stopped on an error, and closes tools on an abort", () => {
    const failed = makeEventMapper("/work")
    failed.apply({
      type: "message_end",
      message: { role: "assistant", stopReason: "error", errorMessage: "No API key for provider: openrouter" },
    })
    expect(failed.settle(false, null)).toStrictEqual([
      {
        type: "turn_failed",
        message: "No API key for provider: openrouter",
        signedOut: true,
        loginCommand: "pi auth login",
      },
    ])

    const retried = makeEventMapper("/work")
    retried.apply({ type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "529" } })
    retried.apply({ type: "message_end", message: { role: "assistant", stopReason: "stop" } })
    expect(retried.settle(false, null)).toStrictEqual([
      { type: "turn_completed", usage: { inputTokens: 0, outputTokens: 0 } },
    ])

    const aborted = makeEventMapper("/work")
    aborted.apply({ type: "tool_execution_start", toolCallId: "b", toolName: "bash", args: { command: "sleep 9" } })
    expect(aborted.settle(true, null)).toStrictEqual([
      { type: "tool_call_finished", callId: "b", output: "Interrupted", isError: true },
      { type: "turn_failed", message: "Turn interrupted" },
    ])
  })
})
