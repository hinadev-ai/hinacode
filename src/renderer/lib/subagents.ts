import { useNavigate } from "@tanstack/react-router"
import type { SubagentStatus } from "../../shared/agent.ts"
import type { Message, MessagePart, ToolCallStatus } from "../../shared/domain.ts"

type ToolCall = Extract<MessagePart, { type: "tool_call" }>

/** A sub-agent's status read off its spawning tool call, for when the provider has not reported it. */
export const statusOfCall = {
  running: "running",
  done: "completed",
  error: "failed",
} satisfies Record<ToolCallStatus, SubagentStatus>

/** Claude's tool for spawning a sub-agent, named Task before it became Agent. */
export const spawnsSubagent = (part: ToolCall) => part.name === "Agent" || part.name === "Task"

export const isOwnPart = (part: MessagePart) => part.type !== "tool_call" || part.parentCallId === undefined

/** Opens a sub-agent's transcript by its `callId`, or the thread's own transcript when undefined. */
export function useOpenSubagent(threadId: string) {
  const navigate = useNavigate()
  return (callId: string | undefined) =>
    void navigate({
      to: "/thread/$threadId",
      params: { threadId },
      search: callId === undefined ? {} : { agent: callId },
    })
}

/**
 * What the transcript holds about one sub-agent: the tool call that spawned it (Claude only) and,
 * in order, the calls it made. The calls lose `parentCallId` so they render as the view's own.
 */
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

/** A string field of a tool call's input, such as the Agent tool's `description` or `prompt`. */
export const inputField = (part: ToolCall | undefined, key: string): string | undefined => {
  const value: unknown =
    typeof part?.input === "object" && part.input !== null ? Reflect.get(part.input, key) : undefined
  return typeof value === "string" ? value : undefined
}

/**
 * The report inside the text Claude's Agent tool hands back. Claude frames it, indents every report
 * line by two spaces so a forged frame line stands out, and appends the agent id and usage.
 */
export function subagentReport(text: string): string {
  const [first = "", ...rest] = text.split("\n")
  if (!first.startsWith("[Subagent hand-back]")) return text.replace(/\nagentId: [\s\S]*$/, "").trim()
  const end = rest.findIndex((line) => line !== "" && !line.startsWith("  "))
  return (end === -1 ? rest : rest.slice(0, end))
    .map((line) => line.slice(2))
    .join("\n")
    .trim()
}
