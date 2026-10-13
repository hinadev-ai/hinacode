import type { Message, MessagePart } from "../../shared/domain.ts"
import { isOwnPart } from "./subagents.ts"
import { groupCommands, type TranscriptBlock } from "./toolCall.ts"

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

export function assistantPresentation(message: Message, summarizeWork = true): AssistantPresentation {
  const parts = message.parts.flatMap((part, index) => (isOwnPart(part) ? [{ part, index }] : []))
  if (message.role === "user" || message.completedAt === null || !summarizeWork) return { kind: "inline", parts }
  const durationMs = Date.parse(message.completedAt) - Date.parse(message.createdAt)
  if (!(durationMs >= 0)) return { kind: "inline", parts }

  const workEnd = parts.findLastIndex(({ part }) => isWork(part)) + 1
  const work = parts.slice(0, workEnd).filter(({ part }) => !staysInReply(part))
  const reply = parts.filter(({ part }, position) => position >= workEnd || staysInReply(part))
  return { kind: "completed", durationMs, work, reply }
}

/** Disclosures can leave gaps in the original indices, so commands group only within each contiguous run. */
export function presentationBlocks(parts: ReadonlyArray<IndexedMessagePart>): Array<TranscriptBlock> {
  const blocks: Array<TranscriptBlock> = []
  let start = 0
  let firstIndex = 0
  for (const [position, { index }] of parts.entries()) {
    if (position === start) firstIndex = index
    if (parts[position + 1]?.index === index + 1) continue
    blocks.push(
      ...groupCommands(
        parts.slice(start, position + 1).map(({ part }) => part),
        firstIndex,
      ),
    )
    start = position + 1
  }
  return blocks
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
