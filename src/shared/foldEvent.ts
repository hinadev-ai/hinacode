import type { AgentEvent } from "./agent.ts"
import type { Message, MessagePart } from "./domain.ts"

export function foldEvent(message: Message, event: AgentEvent, now: string): Message {
  switch (event.type) {
    case "text_delta":
      return { ...message, parts: appendText(message.parts, "text", event.text) }
    case "reasoning_delta":
      return { ...message, parts: appendText(message.parts, "reasoning", event.text) }
    case "tool_call_started":
      return {
        ...message,
        parts: [
          ...message.parts,
          {
            type: "tool_call",
            callId: event.callId,
            name: event.name,
            input: event.input,
            status: "running",
            ...(event.parentCallId !== undefined && { parentCallId: event.parentCallId }),
          },
        ],
      }
    case "tool_call_finished":
      return {
        ...message,
        parts: message.parts.map((part) =>
          part.type === "tool_call" && part.callId === event.callId
            ? {
                ...part,
                output: event.output,
                ...(event.fullOutputBytes !== undefined && { fullOutputBytes: event.fullOutputBytes }),
                status: event.isError ? "error" : "done",
              }
            : part,
        ),
      }
    case "file_changed":
      return {
        ...message,
        parts: [...message.parts, { type: "file_change", path: event.path, diff: event.diff ?? "" }],
      }
    case "questions_posted":
      return {
        ...message,
        parts: [...message.parts, { type: "questions", text: event.text, questions: event.questions }],
      }
    case "compaction_updated": {
      const part = { type: "compaction" as const, compaction: event.compaction }
      const running = message.parts.findLastIndex(isRunningCompaction)
      return {
        ...message,
        parts:
          running === -1
            ? [...message.parts, part]
            : message.parts.map((existing, index) => (index === running ? part : existing)),
      }
    }
    case "turn_completed":
      return {
        ...message,
        parts: failRunningParts(message.parts),
        completedAt: now,
        usage: event.usage ?? null,
        forkPoint: event.forkPoint ?? null,
      }
    case "turn_failed":
      return {
        ...message,
        parts: [...failRunningParts(message.parts), { type: "text", text: `**Error:** ${event.message}` }],
        completedAt: now,
      }
    case "turn_limited":
      return {
        ...message,
        parts: [...failRunningParts(message.parts), { type: "text", text: event.limit.message }],
        completedAt: now,
      }
    default:
      return message
  }
}

export function foldTranscript(
  messages: ReadonlyArray<Message>,
  event: AgentEvent,
  now: string,
): ReadonlyArray<Message> {
  const latest = messages.findLastIndex((message) => message.role === "assistant")
  if (latest === -1) return messages
  const target =
    event.type === "tool_call_finished"
      ? messages.findLastIndex((message) => message.parts.some((part) => isToolCall(part, event.callId)))
      : latest
  if (target === -1) return messages

  let next = messages
  const folded = foldEvent(messages[target]!, event, now)
  if (folded !== messages[target]) next = messages.map((message, index) => (index === target ? folded : message))
  if (event.type === "turn_completed" || event.type === "turn_failed" || event.type === "turn_limited") {
    next = next.map((message, index) => {
      if (index === target) return message
      const parts = failRunningParts(message.parts)
      return parts === message.parts ? message : { ...message, parts }
    })
  }
  return next
}

const isToolCall = (part: MessagePart, callId: string) => part.type === "tool_call" && part.callId === callId

const isRunningCompaction = (part: MessagePart) => part.type === "compaction" && part.compaction.status === "running"
const isRunning = (part: MessagePart) =>
  (part.type === "tool_call" && part.status === "running") || isRunningCompaction(part)

export function failRunningParts(parts: ReadonlyArray<MessagePart>): ReadonlyArray<MessagePart> {
  if (!parts.some(isRunning)) return parts
  return parts.map((part): MessagePart => {
    if (part.type === "tool_call" && part.status === "running") return { ...part, status: "error" }
    if (isRunningCompaction(part)) return { type: "compaction", compaction: { status: "failed", message: null } }
    return part
  })
}

function appendText(
  parts: ReadonlyArray<MessagePart>,
  type: "text" | "reasoning",
  text: string,
): ReadonlyArray<MessagePart> {
  const last = parts.at(-1)
  if (last?.type === type) return [...parts.slice(0, -1), { type, text: last.text + text }]
  return [...parts, { type, text }]
}
