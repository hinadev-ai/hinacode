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
  const summary = summarizeInput(input)
  return { name: part.name, summary: part.name === "Bash" ? unwrapShell(summary) : summary }
}

/** Codex runs every command as `/bin/zsh -lc '<command>'`; the wrapper says nothing about what ran. */
const SHELL_WRAPPER = /^(?:\/\S*\/)?(?:ba|z)?sh -l?c '((?:[^']|'\\'')*)'$/s

const unwrapShell = (command: string) => {
  const inner = SHELL_WRAPPER.exec(command)?.[1]
  return inner === undefined ? command : inner.replaceAll(`'\\''`, "'")
}

type ToolCall = Extract<MessagePart, { type: "tool_call" }>

export type TranscriptBlock =
  | { readonly type: "part"; readonly part: MessagePart; readonly index: number }
  | { readonly type: "commands"; readonly calls: ReadonlyArray<ToolCall>; readonly index: number }

const isCommand = (part: MessagePart): part is ToolCall => part.type === "tool_call" && part.name === "Bash"

/**
 * Folds each run of two or more back-to-back shell commands into one block, so a burst of commands reads
 * as one line. `index` is the block's first part, which stays put as parts are appended.
 */
export function groupCommands(parts: ReadonlyArray<MessagePart>, startIndex = 0): Array<TranscriptBlock> {
  const blocks: Array<TranscriptBlock> = []
  for (const [position, part] of parts.entries()) {
    const index = startIndex + position
    const previous = blocks.at(-1)
    const run =
      previous?.type === "commands" ? previous.calls : previous && isCommand(previous.part) ? [previous.part] : null
    if (previous && run && isCommand(part)) {
      blocks[blocks.length - 1] = { type: "commands", calls: [...run, part], index: previous.index }
    } else {
      blocks.push({ type: "part", part, index })
    }
  }
  return blocks
}

/** What a shell command's row says: the agent's description of it when it gave one, else the command. */
export function describeCommand(call: ToolCall): string {
  const description: unknown =
    typeof call.input === "object" && call.input !== null ? Reflect.get(call.input, "description") : undefined
  return typeof description === "string" && description !== "" ? description : describeToolCall(call).summary
}
