import type { Subagent, SubagentStatus } from "../../../shared/agent.ts"
import type { Item } from "./protocol.ts"

export type Subagents = Map<string, Subagent>

const firstLine = (text: string) => text.trim().split("\n", 1)[0] ?? ""

// FIXME: Muse keeps a `subagent` item inProgress after the child finishes
const statusOf = (item: Item): SubagentStatus => {
  switch (item.status) {
    case "completed":
      return "completed"
    case "cancelled":
      return "stopped"
    case "inProgress":
      break
    default:
      return "failed"
  }
  if (item.controlStatus !== "resultReady") return "running"
  if (item.result?.errorKind === undefined) return "completed"
  return item.result.errorKind === "cancelled" ? "stopped" : "failed"
}

// FIXME: the child's own session sends no frames on this connection, so a row has no tool calls
export function applySubagentItem(subagents: Subagents, item: Item, now: string): Subagent | undefined {
  const current = subagents.get(item.itemId)
  const status = statusOf(item)
  const label = firstLine(item.objective ?? "") || (item.role ?? "") || (item.fallbackText ?? "")
  const next: Subagent = {
    id: current?.id ?? item.subagentId ?? item.itemId,
    label: label === "" ? (current?.label ?? item.itemId) : label,
    callId: item.itemId,
    status,
    summary: item.result?.summary ?? item.failureReason ?? current?.summary ?? null,
    lastTool: null,
    toolUses: null,
    tokens: item.usage === undefined ? (current?.tokens ?? null) : item.usage.inputTokens + item.usage.outputTokens,
    startedAt: current?.startedAt ?? item.recordedAt ?? now,
    endedAt: status === "running" ? null : (current?.endedAt ?? now),
  }
  if (current !== undefined && JSON.stringify(current) === JSON.stringify(next)) return undefined
  subagents.set(item.itemId, next)
  return next
}
