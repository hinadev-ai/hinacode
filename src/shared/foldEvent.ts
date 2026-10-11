import type { AgentEvent } from "./agent.ts"
import type { Message, MessagePart } from "./domain.ts"

/**
 * Applies one agent event to the assistant message of the running turn. Main persists the result
 * and the renderer folds the same events into its live copy, so both always agree.
 * Events that do not touch the transcript (session_bound, approvals) return the message unchanged.
 */
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
          { type: "tool_call", callId: event.callId, name: event.name, input: event.input, status: "running" },
        ],
      }
    case "tool_call_finished":
      return {
        ...message,
        parts: message.parts.map((part) =>
          part.type === "tool_call" && part.callId === event.callId
            ? { ...part, output: event.output, status: event.isError ? "error" : "done" }
            : part,
        ),
      }
    case "file_changed":
      return {
        ...message,
        parts: [...message.parts, { type: "file_change", path: event.path, diff: event.diff ?? "" }],
      }
    case "turn_completed":
      return { ...message, parts: failRunningTools(message.parts), completedAt: now, usage: event.usage ?? null }
    case "turn_failed":
      return {
        ...message,
        parts: [...failRunningTools(message.parts), { type: "text", text: `**Error:** ${event.message}` }],
        completedAt: now,
      }
    default:
      return message
  }
}

/** A turn that ended (interrupted, failed) while tools ran will never report their results. */
function failRunningTools(parts: ReadonlyArray<MessagePart>): ReadonlyArray<MessagePart> {
  if (!parts.some((part) => part.type === "tool_call" && part.status === "running")) return parts
  return parts.map((part) => (part.type === "tool_call" && part.status === "running" ? { ...part, status: "error" } : part))
}

/** Deltas extend the trailing part of the same kind, so one streamed paragraph stays one part. */
function appendText(
  parts: ReadonlyArray<MessagePart>,
  type: "text" | "reasoning",
  text: string,
): ReadonlyArray<MessagePart> {
  const last = parts.at(-1)
  if (last?.type === type) return [...parts.slice(0, -1), { type, text: last.text + text }]
  return [...parts, { type, text }]
}
