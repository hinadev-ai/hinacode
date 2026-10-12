import type { Message, MessagePart } from "../../shared/domain.ts"

export interface IndexedMessagePart {
  readonly part: MessagePart
  readonly index: number
}

export type AssistantPresentation =
  | { readonly kind: "inline"; readonly parts: ReadonlyArray<IndexedMessagePart> }
  | {
      readonly kind: "completed"
      readonly durationMs: number
      readonly work: ReadonlyArray<IndexedMessagePart>
      readonly reply: ReadonlyArray<IndexedMessagePart>
    }

const isWork = (part: MessagePart) =>
  part.type === "reasoning" || part.type === "tool_call" || part.type === "file_change"

const staysInReply = (part: MessagePart) => part.type === "questions" || part.type === "attachment"
const isTopLevelPart = (part: MessagePart) => part.type !== "tool_call" || part.parentCallId === undefined

export function assistantPresentation(message: Message, summarizeWork = true): AssistantPresentation {
  const parts = message.parts.flatMap((part, index) => (isTopLevelPart(part) ? [{ part, index }] : []))
  if (message.role === "user" || message.completedAt === null || !summarizeWork) return { kind: "inline", parts }
  const durationMs = Date.parse(message.completedAt) - Date.parse(message.createdAt)
  if (!(durationMs >= 0)) return { kind: "inline", parts }

  const workEnd = parts.findLastIndex(({ part }) => isWork(part)) + 1
  const work = parts.slice(0, workEnd).filter(({ part }) => !staysInReply(part))
  const reply = parts.filter(({ part }, position) => position >= workEnd || staysInReply(part))
  return { kind: "completed", durationMs, work, reply }
}

const twoDigits = (value: number) => String(value).padStart(2, "0")

export function formatWorkDuration(ms: number): string {
  const totalSeconds = Number.isFinite(ms) ? Math.max(0, Math.floor(ms / 1000)) : 0
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  return hours > 0
    ? `${hours}:${twoDigits(minutes)}:${twoDigits(seconds)}`
    : `${twoDigits(minutes)}:${twoDigits(seconds)}`
}
