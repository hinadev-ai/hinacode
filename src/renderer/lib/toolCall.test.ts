import { describe, expect, test } from "@effect/vitest"
import type { MessagePart } from "../../shared/domain.ts"
import { describeCommand, groupCommands } from "./toolCall.ts"

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

describe("groupCommands", () => {
  test("folds back-to-back shell commands into one block that keeps the first part's index", () => {
    const parts = [text("look"), bash("a"), bash("b"), bash("c"), text("done")]
    expect(groupCommands(parts)).toStrictEqual([
      { type: "part", part: parts[0], index: 0 },
      { type: "commands", calls: [parts[1], parts[2], parts[3]], index: 1 },
      { type: "part", part: parts[4], index: 4 },
    ])
  })

  test("leaves a lone command, and commands split by other parts, as they are", () => {
    const parts = [bash("a"), read("r"), bash("b"), text("x"), bash("c")]
    expect(groupCommands(parts).map((block) => block.type)).toStrictEqual(["part", "part", "part", "part", "part"])
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
