import { TOOL_OUTPUT_PREVIEW_CHARS } from "@shared/compactTranscript.ts"
import { describe, expect, it } from "vitest"
import { copy } from "./copy"
import { describeToolCall, shownOutput, toolIcon } from "./tool-call"

describe("describeToolCall", () => {
  it("shows a command without the login shell Codex wraps it in", () => {
    expect(describeToolCall({ name: "Bash", input: { command: "/bin/zsh -lc 'pnpm test'" } })).toEqual({
      name: "Bash",
      summary: "pnpm test",
    })
  })

  it("names HinaCode's own tools in the phone's words, whatever prefix the agent puts on them", () => {
    const label = copy("tool_own_create_thread")
    expect(describeToolCall({ name: "mcp__hinacode__create_thread", input: {} }).name).toBe(label)
    expect(describeToolCall({ name: "create_thread", input: {} }).name).toBe(label)
  })

  it("keeps any other tool's name and summarizes it by its compact input", () => {
    expect(describeToolCall({ name: "Read", input: { file_path: "src/a.ts" } })).toEqual({
      name: "Read",
      summary: "src/a.ts",
    })
    expect(describeToolCall({ name: "mcp__kicad__run_drc", input: {} })).toEqual({
      name: "mcp__kicad__run_drc",
      summary: "",
    })
  })
})

describe("toolIcon", () => {
  it("picks an icon by what the tool does and falls back to tools", () => {
    expect(toolIcon("Bash")).toBe("Terminal")
    expect(toolIcon("Write")).toBe("Pencil")
    expect(toolIcon("Grep")).toBe("Search")
    expect(toolIcon("WebFetch")).toBe("Globe")
    expect(toolIcon("mcp__hinacode__watch_pull_request")).toBe("RiGitPullRequestLine")
    expect(toolIcon("mcp__kicad__run_drc")).toBe("Tools")
  })
})

describe("shownOutput", () => {
  it("strips color codes and trailing whitespace from command output", () => {
    expect(shownOutput("\x1b[32mok\x1b[0m 3 tests\n\n")).toEqual({ text: "ok 3 tests", truncated: false })
  })

  it("reads the text blocks of an MCP result and names its images", () => {
    const output = { content: [{ type: "text", text: "saved" }, { type: "image", data: "…" }] }
    expect(shownOutput(output).text).toBe(`saved\n${copy("mobile_chat_tool_output_image")}`)
  })

  it("prints any other value as JSON and nothing as empty", () => {
    expect(shownOutput({ ok: true }).text).toBe('{\n  "ok": true\n}')
    expect(shownOutput(undefined).text).toBe("")
    expect(shownOutput(null).text).toBe("")
  })

  it("keeps only the end of a long output, from the start of a line", () => {
    const lines = Array.from({ length: 2000 }, (_, index) => `line ${index}`)
    const { text, truncated } = shownOutput(lines.join("\n"))
    expect(truncated).toBe(true)
    expect(text.length).toBeLessThanOrEqual(TOOL_OUTPUT_PREVIEW_CHARS)
    expect(text.startsWith("line ")).toBe(true)
    expect(text.endsWith("line 1999")).toBe(true)
  })
})
