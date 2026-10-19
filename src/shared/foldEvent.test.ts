import { describe, expect, test } from "@effect/vitest"
import type { Message } from "./domain.ts"
import { foldEvent, foldTranscript } from "./foldEvent.ts"

const now = "2026-10-12T00:00:01.000Z"
const assistant = (id: string, parts: Message["parts"] = []): Message => ({
  id,
  threadId: "t1",
  role: "assistant",
  parts,
  createdAt: "2026-10-12T00:00:00.000Z",
  completedAt: null,
  usage: null,
})
const user = (id: string): Message => ({ ...assistant(id), role: "user", parts: [{ type: "text", text: "hi" }] })

describe("foldEvent", () => {
  test("streams consecutive deltas of one kind into a single part", () => {
    const folded = [
      { type: "text_delta" as const, text: "Hel" },
      { type: "text_delta" as const, text: "lo" },
      { type: "reasoning_delta" as const, text: "why" },
      { type: "text_delta" as const, text: "!" },
    ].reduce((message, event) => foldEvent(message, event, now), assistant("m1"))
    expect(folded.parts).toStrictEqual([
      { type: "text", text: "Hello" },
      { type: "reasoning", text: "why" },
      { type: "text", text: "!" },
    ])
  })

  test("a tool call runs until its result arrives", () => {
    const started = foldEvent(
      assistant("m1"),
      { type: "tool_call_started", callId: "c1", name: "Read", input: {} },
      now,
    )
    expect(started.parts).toStrictEqual([
      { type: "tool_call", callId: "c1", name: "Read", input: {}, status: "running" },
    ])
    const finished = foldEvent(started, { type: "tool_call_finished", callId: "c1", output: "ok", isError: false }, now)
    expect(finished.parts[0]).toMatchObject({ status: "done", output: "ok" })
    const failed = foldEvent(started, { type: "tool_call_finished", callId: "c1", output: "boom", isError: true }, now)
    expect(failed.parts[0]).toMatchObject({ status: "error" })
  })

  test("turn_completed closes the message and fails tools still running", () => {
    const running = assistant("m1", [{ type: "tool_call", callId: "c1", name: "Bash", input: {}, status: "running" }])
    const done = foldEvent(running, { type: "turn_completed", usage: { inputTokens: 1, outputTokens: 2 } }, now)
    expect(done.completedAt).toBe(now)
    expect(done.usage).toStrictEqual({ inputTokens: 1, outputTokens: 2 })
    expect(done.parts[0]).toMatchObject({ status: "error" })
  })

  test("turn_failed appends the error to the transcript", () => {
    const failed = foldEvent(assistant("m1"), { type: "turn_failed", message: "Interrupted" }, now)
    expect(failed.parts).toStrictEqual([{ type: "text", text: "**Error:** Interrupted" }])
    expect(failed.completedAt).toBe(now)
  })

  test("a limit ends every outstanding tool and retains the provider explanation", () => {
    const messages = [
      assistant("m1", [{ type: "tool_call", callId: "c1", name: "Bash", input: {}, status: "running" }]),
      user("u2"),
      assistant("m3"),
    ]
    const next = foldTranscript(
      messages,
      { type: "turn_limited", limit: { kind: "org_spend", message: "Spend limit reached", reset: null } },
      now,
    )
    expect(next[0]?.parts[0]).toMatchObject({ status: "error" })
    expect(next[2]?.parts).toEqual([{ type: "text", text: "Spend limit reached" }])
    expect(next[2]?.completedAt).toBe(now)
  })

  test("events that do not touch the transcript return the same message", () => {
    const message = assistant("m1")
    expect(foldEvent(message, { type: "session_bound", providerSessionId: "s" }, now)).toBe(message)
    expect(foldEvent(message, { type: "approval_resolved", requestId: "a" }, now)).toBe(message)
  })
})

describe("foldTranscript", () => {
  const steered = [
    assistant("m1", [{ type: "tool_call", callId: "c1", name: "Bash", input: {}, status: "running" }]),
    user("u2"),
    assistant("m3"),
  ]

  test("deltas go to the latest assistant message", () => {
    const next = foldTranscript(steered, { type: "text_delta", text: "x" }, now)
    expect(next[2]?.parts).toStrictEqual([{ type: "text", text: "x" }])
    expect(next[0]).toBe(steered[0])
  })

  test("a tool result lands in the message that holds the call, even after a steer", () => {
    const next = foldTranscript(steered, { type: "tool_call_finished", callId: "c1", output: 1, isError: false }, now)
    expect(next[0]?.parts[0]).toMatchObject({ status: "done" })
    expect(next[2]).toBe(steered[2])
  })

  test("ending the turn fails running tools in every earlier message", () => {
    const next = foldTranscript(steered, { type: "turn_completed" }, now)
    expect(next[0]?.parts[0]).toMatchObject({ status: "error" })
    expect(next[2]?.completedAt).toBe(now)
  })

  test("a transcript without an assistant message is left alone", () => {
    const only = [user("u1")]
    expect(foldTranscript(only, { type: "text_delta", text: "x" }, now)).toBe(only)
  })
})
