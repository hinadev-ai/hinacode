import type { MessagePart } from "../../shared/domain.ts"

const SUMMARY_KEYS = ["command", "file_path", "notebook_path", "pattern", "path", "url", "query", "description"]

/** The one input field that best says what a tool call does, for the collapsed row. */
function summarizeInput(input: unknown): string {
  if (typeof input !== "object" || input === null) return ""
  for (const key of SUMMARY_KEYS) {
    const value: unknown = Reflect.get(input, key)
    if (typeof value === "string") return value
  }
  return JSON.stringify(input)
}

/**
 * Codex MCP calls carry the whole `mcpToolCall` item as input and only the bare tool as name, so
 * name them `server/tool` and summarize their arguments rather than the item.
 */
export function describeToolCall(part: Extract<MessagePart, { type: "tool_call" }>): {
  name: string
  summary: string
} {
  const { input } = part
  if (typeof input === "object" && input !== null && Reflect.get(input, "type") === "mcpToolCall") {
    return {
      name: `${String(Reflect.get(input, "server"))}/${String(Reflect.get(input, "tool"))}`,
      summary: summarizeInput(Reflect.get(input, "arguments")),
    }
  }
  return { name: part.name, summary: summarizeInput(input) }
}
