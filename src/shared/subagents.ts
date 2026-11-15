import { type Subagent, type SubagentStatus, toolArgument } from "./agent.ts"
import { compactPart, previewPart } from "./compactTranscript.ts"
import type { Message, MessagePart, ToolCallStatus } from "./domain.ts"

type ToolCall = Extract<MessagePart, { type: "tool_call" }>

export const statusOfCall = {
  running: "running",
  done: "completed",
  error: "failed",
} satisfies Record<ToolCallStatus, SubagentStatus>

export function findSubagentWork(messages: ReadonlyArray<Message>, callId: string) {
  let spawn: ToolCall | undefined
  let startedAt: string | undefined
  const calls: Array<ToolCall> = []
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type !== "tool_call") continue
      if (part.callId === callId) spawn = part
      else if (part.parentCallId === callId) {
        const { parentCallId: _, ...own } = part
        calls.push(own)
      } else continue
      startedAt ??= message.createdAt
    }
  }
  return { spawn, calls, startedAt }
}

export function compactSubagentWork(messages: ReadonlyArray<Message>, callId: string) {
  const { spawn, calls, startedAt } = findSubagentWork(messages, callId)
  return { spawn: spawn ?? null, calls: calls.map(compactPart), startedAt: startedAt ?? null }
}

export function previewSubagentWork(messages: ReadonlyArray<Message>, callId: string) {
  const { spawn, calls, startedAt } = findSubagentWork(messages, callId)
  return { spawn: spawn ?? null, calls: calls.map(previewPart), startedAt: startedAt ?? null }
}

type SubagentWork = {
  readonly spawn: MessagePart | null | undefined
  readonly calls: ReadonlyArray<MessagePart>
  readonly startedAt: string | null | undefined
}

const toolCalls = (part: MessagePart | null | undefined): ReadonlyArray<ToolCall> =>
  part?.type === "tool_call" ? [part] : []

export function mergeSubagentWork(fetched: SubagentWork | undefined, live: SubagentWork) {
  const liveCalls = live.calls.flatMap(toolCalls)
  const fetchedCalls = (fetched?.calls ?? []).flatMap(toolCalls)
  const liveById = new Map(liveCalls.map((part) => [part.callId, part]))
  const fetchedIds = new Set(fetchedCalls.map((part) => part.callId))
  return {
    spawn: toolCalls(live.spawn)[0] ?? toolCalls(fetched?.spawn)[0],
    calls: [
      ...fetchedCalls.map((part) => liveById.get(part.callId) ?? part),
      ...liveCalls.filter((part) => !fetchedIds.has(part.callId)),
    ],
    startedAt: live.startedAt ?? fetched?.startedAt ?? undefined,
  }
}

export const inputField = (part: ToolCall | undefined, key: string): string | undefined => {
  const value = toolArgument(part?.input, key)
  return typeof value === "string" ? value : undefined
}

// FIXME: Claude frames the Agent tool's report, indents it by two spaces and appends the agent id
export function subagentReport(text: string): string {
  const [first = "", ...rest] = text.split("\n")
  if (!first.startsWith("[Subagent hand-back]")) return text.replace(/\nagentId: [\s\S]*$/, "").trim()
  const end = rest.findIndex((line) => line !== "" && !line.startsWith("  "))
  return (end === -1 ? rest : rest.slice(0, end))
    .map((line) => line.slice(2))
    .join("\n")
    .trim()
}

export function inFlight(subagents: ReadonlyArray<Subagent>) {
  const running = subagents.filter((subagent) => subagent.status === "running")
  if (running.length === 0) return []
  const since = Math.min(...running.map((subagent) => Date.parse(subagent.startedAt)))
  return subagents.filter((subagent) => subagent.endedAt === null || Date.parse(subagent.endedAt) >= since).reverse()
}
