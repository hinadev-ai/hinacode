import { describe, expect, test } from "@effect/vitest"
import type { MessagePart } from "../../shared/domain.ts"
import { countToolKinds, describeCommand, groupToolCalls } from "./toolCall.ts"

const bash = (callId: string, input: object = { command: `echo ${callId}` }): MessagePart => ({
  type: "tool_call",
  callId,
  name: "Bash",
  input,
  status: "done",
})
const read = (callId: string): MessagePart => ({
  type: "tool_call",
  callId,
  name: "Read",
  input: { file_path: "a.ts" },
  status: "done",
})
const text = (value: string): MessagePart => ({ type: "text", text: value })

const agent = (callId: string): MessagePart => ({
  type: "tool_call",
  callId,
  name: "Agent",
  input: { description: "Explore" },
  status: "running",
})

describe("groupToolCalls", () => {
  test("folds back-to-back tool calls of any kind into one block that keeps the first part's index", () => {
    const parts = [text("look"), bash("a"), read("r"), bash("c"), text("done")]
    expect(groupToolCalls(parts)).toStrictEqual([
      { type: "part", part: parts[0], index: 0 },
      { type: "tools", calls: [parts[1], parts[2], parts[3]], index: 1 },
      { type: "part", part: parts[4], index: 4 },
    ])
  })

  test("leaves a lone call, calls split by other parts, and sub-agent calls as they are", () => {
    const parts = [bash("a"), text("x"), read("r"), agent("s"), bash("c")]
    expect(groupToolCalls(parts).map((block) => block.type)).toStrictEqual(["part", "part", "part", "part", "part"])
  })
})

describe("countToolKinds", () => {
  test("counts calls per kind in summary order and skips kinds that never ran", () => {
    const calls = [read("r1"), bash("a"), read("r2"), { ...read("w"), name: "WebFetch" }] as Array<
      Extract<MessagePart, { type: "tool_call" }>
    >
    expect(countToolKinds(calls)).toStrictEqual([
      { kind: "command", count: 1 },
      { kind: "read", count: 2 },
      { kind: "other", count: 1 },
    ])
  })
})

describe("describeCommand", () => {
  test("prefers the agent's description of the command, else the command itself", () => {
    const described = bash("a", { command: "ls -la", description: "List repo contents" })
    expect(describeCommand(described as Extract<MessagePart, { type: "tool_call" }>)).toBe("List repo contents")
    expect(describeCommand(bash("b", { command: "ls -la" }) as Extract<MessagePart, { type: "tool_call" }>)).toBe(
      "ls -la",
    )
  })
})
