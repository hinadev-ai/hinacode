import { describe, expect, test } from "@effect/vitest"
import { editedPath, toolInput, toolName, toolResult } from "./items.ts"
import type { Item } from "./protocol.ts"

const tool = (fields: Partial<Item>): Item => ({
  itemId: "0199a8f0-0000-7000-8000-000000000001",
  kind: "toolCall",
  revision: 2,
  status: "completed",
  ...fields,
})

const receipt = (output: string, exitCode: number) =>
  JSON.stringify({ output, exit_code: exitCode, wall_time_ms: 12, truncated: false })

describe("toolName", () => {
  test("names Muse's built-in tools as Claude Code does", () => {
    expect(
      ["bash", "read_file", "write_file", "edit_file", "search", "web_fetch", "web_search"].map(toolName),
    ).toStrictEqual(["Bash", "Read", "Write", "Edit", "Grep", "WebFetch", "WebSearch"])
  })

  test("keeps any other tool's name", () => {
    expect(toolName("request_user_input")).toBe("request_user_input")
    expect(toolName("mcp__kkcode__review_changes")).toBe("mcp__kkcode__review_changes")
  })
})

describe("toolInput", () => {
  test("parses the model's JSON arguments", () => {
    expect(toolInput('{"command":"ls","description":"List files"}')).toStrictEqual({
      command: "ls",
      description: "List files",
    })
  })

  test("keeps arguments that are not JSON as written, and is empty without any", () => {
    expect(toolInput('{"command": "ls"')).toBe('{"command": "ls"')
    expect(toolInput(undefined)).toStrictEqual({})
  })
})

describe("toolResult", () => {
  test("shows what a bash command printed, not its receipt", () => {
    expect(toolResult(tool({ tool: "bash", visibleOutput: receipt("one\ntwo\n", 0) }), undefined)).toStrictEqual({
      output: "one\ntwo\n",
      isError: false,
    })
  })

  test("is an error when the command exits non-zero", () => {
    expect(toolResult(tool({ tool: "bash", visibleOutput: receipt("no such file\n", 2) }), undefined)).toStrictEqual({
      output: "no such file\n",
      isError: true,
    })
  })

  test("falls back to the streamed output, and says why a call that printed nothing was stopped", () => {
    expect(toolResult(tool({ tool: "bash" }), "partial")).toStrictEqual({ output: "partial", isError: false })
    expect(
      toolResult(tool({ tool: "bash", status: "rejected", failureReason: "Denied by the user" }), undefined),
    ).toStrictEqual({ output: "Denied by the user", isError: true })
    expect(toolResult(tool({ tool: "bash", status: "cancelled" }), undefined)).toStrictEqual({
      output: "Tool cancelled",
      isError: true,
    })
  })

  test("passes other tools' text through", () => {
    expect(toolResult(tool({ tool: "read_file", visibleOutput: "1\thello" }), undefined)).toStrictEqual({
      output: "1\thello",
      isError: false,
    })
  })
})

describe("editedPath", () => {
  test("resolves a finished write or edit against the workspace", () => {
    expect(editedPath(tool({ tool: "write_file", args: '{"path":"src/a.ts","content":"x"}' }), "/repo")).toBe(
      "/repo/src/a.ts",
    )
    expect(editedPath(tool({ tool: "edit_file", args: '{"path":"/abs/b.ts"}' }), "/repo")).toBe("/abs/b.ts")
  })

  test("is undefined for a failed edit, another tool, or arguments without a path", () => {
    expect(editedPath(tool({ tool: "write_file", status: "failed", args: '{"path":"a"}' }), "/repo")).toBeUndefined()
    expect(editedPath(tool({ tool: "read_file", args: '{"path":"a"}' }), "/repo")).toBeUndefined()
    expect(editedPath(tool({ tool: "edit_file", args: "not json" }), "/repo")).toBeUndefined()
  })
})
