import type { Subagent, SubagentStatus } from "../../../shared/agent.ts"
import type { CollabAgentStatus, ServerNotificationParams, ThreadItem } from "./protocol.ts"

export type Subagents = Map<string, Subagent>

const statusOf: Record<CollabAgentStatus, SubagentStatus> = {
  pendingInit: "running",
  running: "running",
  completed: "completed",
  shutdown: "completed",
  interrupted: "stopped",
  errored: "failed",
  notFound: "failed",
}

const firstLine = (text: string) => text.trim().split("\n", 1)[0] ?? ""

const nameFromPath = (agentPath: string) => agentPath.split("/").findLast((segment) => segment !== "") ?? agentPath

const update = (subagents: Subagents, id: string, patch: Partial<Subagent>) => {
  const current = subagents.get(id)
  if (current === undefined) return undefined
  const next = { ...current, ...patch }
  subagents.set(id, next)
  return next
}

export function applyParentItem(subagents: Subagents, item: ThreadItem, now: string): Array<Subagent> {
  // FIXME: Codex reports each activity on both item/started and item/completed
  if (item.type === "subAgentActivity") {
    const id = item.agentThreadId
    const current = subagents.get(id)
    if (item.kind === "started" || item.kind === "interacted") {
      if (current !== undefined) return []
      const started: Subagent = {
        id,
        label: nameFromPath(item.agentPath),
        callId: id,
        status: "running",
        summary: null,
        lastTool: null,
        toolUses: 0,
        tokens: 0,
        startedAt: now,
        endedAt: null,
      }
      subagents.set(id, started)
      return [started]
    }
    if (current?.status !== "running") return []
    return [update(subagents, id, { status: item.kind === "completed" ? "completed" : "stopped", endedAt: now })!]
  }

  if (item.type !== "collabAgentToolCall") return []
  const changed: Array<Subagent> = []
  if (item.tool === "spawnAgent" && item.prompt) {
    for (const id of item.receiverThreadIds) {
      const next = update(subagents, id, { label: firstLine(item.prompt) })
      if (next) changed.push(next)
    }
  }
  for (const [id, state] of Object.entries(item.agentsStates)) {
    if (state === undefined) continue
    const status = statusOf[state.status]
    const current = subagents.get(id)
    if (current === undefined || (current.status === status && state.message === null)) continue
    const next = update(subagents, id, {
      status,
      summary: state.message ?? current.summary,
      endedAt: status === "running" ? null : (current.endedAt ?? now),
    })
    if (next) changed.push(next)
  }
  return changed
}

export function applyChildNotification(
  subagents: Subagents,
  childThreadId: string,
  method: string,
  params: unknown,
  toolName: (item: ThreadItem) => string | undefined,
): Subagent | undefined {
  const current = subagents.get(childThreadId)
  if (current === undefined) return undefined
  switch (method) {
    case "item/started": {
      const { item } = params as ServerNotificationParams["item/started"]
      const name = toolName(item)
      if (name === undefined) return undefined
      return update(subagents, childThreadId, { lastTool: name, toolUses: (current.toolUses ?? 0) + 1 })
    }
    case "item/completed": {
      const { item } = params as ServerNotificationParams["item/completed"]
      if (item.type !== "agentMessage" || item.text.trim() === "") return undefined
      return update(subagents, childThreadId, { summary: item.text.trim() })
    }
    case "thread/tokenUsage/updated": {
      const { tokenUsage } = params as ServerNotificationParams["thread/tokenUsage/updated"]
      return update(subagents, childThreadId, { tokens: tokenUsage.total.totalTokens })
    }
    default:
      return undefined
  }
}
