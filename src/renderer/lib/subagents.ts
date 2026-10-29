import { useNavigate } from "@tanstack/react-router"
import type { SubagentStatus } from "../../shared/agent.ts"
import type { Message, MessagePart, ToolCallStatus } from "../../shared/domain.ts"

type ToolCall = Extract<MessagePart, { type: "tool_call" }>

export const statusOfCall = {
  running: "running",
  done: "completed",
  error: "failed",
} satisfies Record<ToolCallStatus, SubagentStatus>

// FIXME: Claude Code named its sub-agent tool Task before it became Agent
export const spawnsSubagent = (part: ToolCall) => part.name === "Agent" || part.name === "Task"

export const isOwnPart = (part: MessagePart) => part.type !== "tool_call" || part.parentCallId === undefined

export function useOpenSubagent(threadId: string) {
  const navigate = useNavigate()
  return (callId: string | undefined) =>
    void navigate({
      to: "/thread/$threadId",
      params: { threadId },
      search: callId === undefined ? {} : { agent: callId },
    })
}

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

export const inputField = (part: ToolCall | undefined, key: string): string | undefined => {
  const value: unknown =
    typeof part?.input === "object" && part.input !== null ? Reflect.get(part.input, key) : undefined
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
