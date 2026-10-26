import type { Message, MessagePart } from "./domain.ts"

const SUMMARY_KEYS = ["command", "file_path", "path", "pattern", "url", "description"]

/** The input field that says what a tool call touched, and that field's first line. Null when the input has none. */
export function toolSummary(input: unknown): { readonly key: string; readonly line: string } | null {
  if (typeof input !== "object" || input === null) return null
  const record = input as Record<string, unknown>
  for (const key of SUMMARY_KEYS) {
    const value = record[key]
    if (typeof value === "string") return { key, line: value.split("\n", 1)[0]! }
  }
  return null
}

function compactPart(part: MessagePart): MessagePart {
  switch (part.type) {
    case "tool_call": {
      const { output: _output, input, ...rest } = part
      const summary = toolSummary(input)
      return { ...rest, input: summary === null ? {} : { [summary.key]: summary.line } }
    }
    case "file_change":
      return part.diff === "" ? part : { ...part, diff: "" }
    default:
      return part
  }
}

/**
 * Keeps what the phone's transcript shows: each tool call's summary line instead of its input and output, file
 * changes without their diffs, and none of the calls sub-agents made, which the phone hides. Those are most of a
 * transcript's bytes.
 */
export const compactMessage = (message: Message): Message => ({
  ...message,
  parts: message.parts.filter((part) => part.type !== "tool_call" || part.parentCallId === undefined).map(compactPart),
})

