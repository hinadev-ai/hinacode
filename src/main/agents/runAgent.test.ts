import { expect, test } from "@effect/vitest"
import type { Message } from "../../shared/domain.ts"
import { pickedSubagentModel, spawningCallId } from "./runAgent.ts"

const assistant = (parts: Message["parts"]): Message => ({
  id: "m1",
  threadId: "t1",
  role: "assistant",
  parts,
  createdAt: "2026-10-30T00:00:00.000Z",
  completedAt: null,
  usage: null,
  forkPoint: null,
})

test("finds the running run_agent call with the same prompt on Claude and Codex", () => {
  const messages = [
    assistant([
      { type: "tool_call", callId: "done", name: "mcp__hinacode__run_agent", input: { prompt: "p" }, status: "done" },
      {
        type: "tool_call",
        callId: "other",
        name: "mcp__hinacode__run_agent",
        input: { prompt: "q" },
        status: "running",
      },
      {
        type: "tool_call",
        callId: "claude",
        name: "mcp__hinacode__run_agent",
        input: { prompt: "p" },
        status: "running",
      },
    ]),
  ]
  expect(spawningCallId(messages, "p")).toBe("claude")

  const codex = [
    assistant([
      {
        type: "tool_call",
        callId: "codex",
        name: "run_agent",
        input: { type: "mcpToolCall", server: "hinacode", tool: "run_agent", arguments: { prompt: "p" } },
        status: "running",
      },
    ]),
  ]
  expect(spawningCallId(codex, "p")).toBe("codex")
  expect(spawningCallId(codex, "missing")).toBeUndefined()
})

const pick = (fields: Partial<Parameters<typeof pickedSubagentModel>[0]>) =>
  pickedSubagentModel({ agent: "opencode", requested: undefined, threadModel: null, picked: [], ...fields })

test("refuses every model until the user picks some", () => {
  expect(pick({}).kind).toBe("refused")
  expect(pick({ requested: "openrouter/a" }).kind).toBe("refused")
})

test("defaults to the calling thread's own model, then the first picked one", () => {
  expect(pick({ picked: ["a", "b"] })).toStrictEqual({ kind: "chosen", model: "a" })
  expect(pick({ picked: ["a", "b"], threadModel: "t" })).toStrictEqual({ kind: "chosen", model: "t" })
  expect(pick({ threadModel: "t" })).toStrictEqual({ kind: "chosen", model: "t" })
})

test("lists the allowed models once when the requested one is not among them", () => {
  expect(pick({ picked: ["a", "t"], threadModel: "t", requested: "z" })).toStrictEqual({
    kind: "refused",
    message: "z is not among the opencode models the user picked. Use one of: t, a.",
  })
})
