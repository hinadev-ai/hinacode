import { isAbsolute, join } from "node:path"
import { Predicate } from "effect"
import type { Item } from "./protocol.ts"

/** Muse's tools under the names the transcript gives an icon and a summary, which are Claude Code's. */
const toolNames: Record<string, string> = {
  bash: "Bash",
  read_file: "Read",
  write_file: "Write",
  edit_file: "Edit",
  search: "Grep",
  web_fetch: "WebFetch",
  web_search: "WebSearch",
}

export const toolName = (tool: string) => toolNames[tool] ?? tool

/** The arguments as the model wrote them, which may not be valid JSON. */
export const toolInput = (args: string | undefined): unknown => {
  if (args === undefined) return {}
  try {
    return JSON.parse(args)
  } catch {
    return args
  }
}

/**
 * `bash` reports a JSON receipt whose `output` is what the command printed. Other tools report text. A call that was
 * stopped or rejected usually printed nothing, so its row says why it ended instead.
 */
export const toolResult = (item: Item, streamed: string | undefined): { output: unknown; isError: boolean } => {
  const visible = item.visibleOutput ?? streamed ?? ""
  const receipt = toolInput(visible)
  const printed = Predicate.isObject(receipt) && typeof receipt.output === "string" ? receipt.output : visible
  const exitCode = Predicate.isObject(receipt) ? receipt.exit_code : undefined
  const completed = item.status === "completed"
  return {
    output: printed === "" && !completed ? (item.failureReason ?? `Tool ${item.status}`) : printed,
    isError: !completed || (typeof exitCode === "number" && exitCode !== 0),
  }
}

const editTools = new Set(["write_file", "edit_file"])

/** The file a finished edit wrote, resolved against the workspace the model's relative paths start from. */
export const editedPath = (item: Item, cwd: string): string | undefined => {
  if (item.status !== "completed" || !editTools.has(item.tool ?? "")) return undefined
  const input = toolInput(item.args)
  const path = Predicate.isObject(input) ? input.path : undefined
  if (typeof path !== "string") return undefined
  return isAbsolute(path) ? path : join(cwd, path)
}
