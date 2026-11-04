import { beforeEach, describe, expect, test } from "@effect/vitest"
import type { AgentEvent } from "../../shared/agent.ts"
import { useActivity } from "./activity.ts"

const line = (threadId: string) => useActivity.getState().byThreadId[threadId]
const receive = (threadId: string, event: AgentEvent) => useActivity.getState().receive(threadId, event)
const approval = (detail: string, title = "Install dependencies") =>
  ({
    type: "approval_requested",
    request: { id: "1", threadId: "a", provider: "claude", kind: "command", title, detail },
  }) as const

describe("useActivity", () => {
  beforeEach(() => useActivity.setState({ byThreadId: {} }))

  test("keeps the latest tool call per thread until its turn ends", () => {
    receive("a", { type: "tool_call_started", callId: "1", name: "Read", input: { file_path: "src/a.ts" } })
    receive("a", { type: "tool_call_started", callId: "2", name: "Bash", input: { command: "pnpm test\n--watch" } })
    receive("b", { type: "tool_call_started", callId: "3", name: "Read", input: { file_path: "src/b.ts" } })
    expect(line("a")).toStrictEqual({ text: "pnpm test", code: true, kind: "activity" })
    expect(line("b")?.text).toBe("Read src/b.ts")

    receive("a", { type: "turn_completed" })
    expect(line("a")).toBeUndefined()
  })

  test("holds what an agent asks, then treats an approved command as running", () => {
    receive("a", approval("pnpm install\nsecond line"))
    expect(line("a")).toStrictEqual({ text: "pnpm install", code: true, kind: "ask" })

    receive("a", { type: "approval_resolved", requestId: "1" })
    expect(line("a")).toStrictEqual({ text: "pnpm install", code: true, kind: "activity" })
  })

  test("falls back to the approval's title when it has no detail", () => {
    receive("a", approval("  "))
    expect(line("a")?.text).toBe("Install dependencies")
  })

  test("a tool call does not replace what an agent is still asking", () => {
    receive("a", approval("pnpm install"))
    receive("a", {
      type: "tool_call_started",
      callId: "9",
      name: "Read",
      input: { file_path: "src/a.ts" },
      parentCallId: "1",
    })
    expect(line("a")).toStrictEqual({ text: "pnpm install", code: true, kind: "ask" })
  })

  test("holds a question's text, then its header, and no line when it has neither", () => {
    const asked = (questions: ReadonlyArray<{ readonly header: string; readonly question: string }>) =>
      ({
        type: "question_requested",
        request: {
          id: "q",
          threadId: "a",
          provider: "claude",
          questions: questions.map((question, index) => ({
            id: String(index),
            options: [],
            multiSelect: false,
            allowsText: true,
            secret: false,
            ...question,
          })),
        },
      }) as const
    receive("a", asked([{ header: "Scope", question: "Which files?" }]))
    expect(line("a")?.text).toBe("Which files?")
    receive("a", asked([{ header: "Scope", question: "  " }]))
    expect(line("a")?.text).toBe("Scope")
    receive("a", asked([]))
    expect(line("a")).toBeUndefined()
  })

  test("cuts the JSON payload off a failure", () => {
    receive("a", { type: "turn_failed", message: 'API Error: 529 {"type":"error","error":{"type":"overloaded"}}' })
    expect(line("a")?.text).toBe("API Error: 529")
  })

  test("keeps a failure's first line and drops the line when the user stopped the turn", () => {
    receive("a", { type: "turn_failed", message: "\npnpm install exited 1\nstack" })
    expect(line("a")).toStrictEqual({ text: "pnpm install exited 1", code: false, kind: "failure" })

    receive("a", { type: "turn_failed", message: "Interrupted", stopped: true })
    expect(line("a")).toBeUndefined()
  })

  test("events that carry no line leave the current one alone", () => {
    receive("a", approval("pnpm install"))
    receive("a", { type: "text_delta", messageId: "m", delta: "hi" } as unknown as AgentEvent)
    expect(line("a")?.text).toBe("pnpm install")
  })

  test("forgets a removed thread", () => {
    receive("a", approval("pnpm install"))
    useActivity.getState().forget("a")
    expect(line("a")).toBeUndefined()
  })
})
