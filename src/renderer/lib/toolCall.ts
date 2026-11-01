import { type MessagePart, spawnsSubagent } from "../../shared/domain.ts"

const SUMMARY_KEYS = ["command", "file_path", "notebook_path", "pattern", "path", "url", "query", "description"]

function summarizeInput(input: unknown): string {
  if (typeof input !== "object" || input === null) return ""
  for (const key of SUMMARY_KEYS) {
    const value: unknown = Reflect.get(input, key)
    if (typeof value === "string") return value
  }
  return JSON.stringify(input)
}

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

// FIXME: Codex wraps every command in a login shell, such as /bin/zsh -lc '<command>'
const SHELL_WRAPPER = /^(?:\/\S*\/)?(?:ba|z)?sh -l?c '((?:[^']|'\\'')*)'$/s

const unwrapShell = (command: string) => {
  const inner = SHELL_WRAPPER.exec(command)?.[1]
  return inner === undefined ? command : inner.replaceAll(`'\\''`, "'")
}

type ToolCall = Extract<MessagePart, { type: "tool_call" }>

export type ActivityPart = ToolCall | Extract<MessagePart, { type: "reasoning" }>

export type TranscriptBlock =
  | { readonly type: "part"; readonly part: MessagePart; readonly index: number }
  | { readonly type: "tools"; readonly parts: ReadonlyArray<ActivityPart>; readonly index: number }

const isFoldable = (part: MessagePart): part is ActivityPart =>
  part.type === "reasoning" || (part.type === "tool_call" && !spawnsSubagent(part))

export function groupToolCalls(parts: ReadonlyArray<MessagePart>, startIndex = 0): Array<TranscriptBlock> {
  const blocks: Array<TranscriptBlock> = []
  let run: Array<ActivityPart> = []
  const endRun = (end: number) => {
    const start = end - run.length
    if (run.length > 1 && run.some((part) => part.type === "tool_call")) {
      blocks.push({ type: "tools", parts: run, index: start })
    } else {
      blocks.push(...run.map((part, position) => ({ type: "part" as const, part, index: start + position })))
    }
    run = []
  }
  for (const [position, part] of parts.entries()) {
    const index = startIndex + position
    if (isFoldable(part)) {
      run.push(part)
      continue
    }
    endRun(index)
    blocks.push({ type: "part", part, index })
  }
  endRun(startIndex + parts.length)
  return blocks
}

export type ToolKind = "command" | "read" | "edit" | "search" | "other"

const toolKinds: Record<string, ToolKind> = {
  Bash: "command",
  Read: "read",
  Edit: "edit",
  MultiEdit: "edit",
  Write: "edit",
  NotebookEdit: "edit",
  Glob: "search",
  Grep: "search",
}

export function countToolKinds(calls: ReadonlyArray<ToolCall>): Array<{ kind: ToolKind; count: number }> {
  const counts = new Map<ToolKind, number>(
    (["command", "read", "edit", "search", "other"] as const).map((kind) => [kind, 0]),
  )
  for (const call of calls) {
    const kind = toolKinds[call.name] ?? "other"
    counts.set(kind, (counts.get(kind) ?? 0) + 1)
  }
  return [...counts].flatMap(([kind, count]) => (count > 0 ? [{ kind, count }] : []))
}

export function describeCommand(call: ToolCall): string {
  const description: unknown =
    typeof call.input === "object" && call.input !== null ? Reflect.get(call.input, "description") : undefined
  return typeof description === "string" && description !== "" ? description : describeToolCall(call).summary
}
