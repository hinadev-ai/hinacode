import { Predicate } from "effect"
import type { BackgroundTask } from "../../../shared/agent.ts"
import { toolInput } from "./items.ts"
import type { ToolCall } from "./protocol.ts"

export const isBackgrounded = (item: ToolCall) =>
  item.status === "inProgress" && (item.background === true || item.backgroundStatus?.state === "backgrounded")

/** What the model said the call is for, else its command line, else the tool's name. */
const labelOf = (item: ToolCall) => {
  const input = toolInput(item.args)
  const field = (name: string) => (Predicate.isObject(input) && typeof input[name] === "string" ? input[name] : "")
  return field("description") || field("command") || (item.tool ?? "tool")
}

/**
 * The session's background tasks after `item` changed: added once it runs in the background, dropped once it
 * ends. Returns `previous` itself when nothing changed, so a caller can skip the emit.
 */
export const backgroundTasksAfter = (
  previous: ReadonlyArray<BackgroundTask>,
  item: ToolCall,
  now: string,
): ReadonlyArray<BackgroundTask> => {
  const known = previous.some((task) => task.id === item.itemId)
  // Muse re-emits a finishing shell without its background marker, so only a terminal status ends a task.
  if (item.status !== "inProgress") return known ? previous.filter((task) => task.id !== item.itemId) : previous
  if (known || !isBackgrounded(item)) return previous
  return [
    ...previous,
    { id: item.itemId, kind: item.tool === "bash" ? "shell" : "other", label: labelOf(item), startedAt: now },
  ]
}
