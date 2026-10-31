import { isAbsolute, join } from "node:path"
import { Predicate } from "effect"
import type { Item } from "./protocol.ts"

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

export const toolInput = (args: string | undefined): unknown => {
  if (args === undefined) return {}
  try {
    return JSON.parse(args)
  } catch {
    return args
  }
}

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

export const editedPath = (item: Item, cwd: string): string | undefined => {
  if (item.status !== "completed" || !editTools.has(item.tool ?? "")) return undefined
  const input = toolInput(item.args)
  const path = Predicate.isObject(input) ? input.path : undefined
  if (typeof path !== "string") return undefined
  return isAbsolute(path) ? path : join(cwd, path)
}
