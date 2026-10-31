import { collapsedParts } from "../../shared/activityFold.ts"
import type { Message, MessagePart } from "../../shared/domain.ts"
import { isOwnPart } from "./subagents.ts"
import { groupToolCalls, type TranscriptBlock } from "./toolCall.ts"

export interface IndexedMessagePart {
  readonly part: MessagePart
  readonly index: number
}

export type AssistantPresentation =
  | { readonly kind: "inline"; readonly parts: ReadonlyArray<IndexedMessagePart> }
  | {
      readonly kind: "completed"
      readonly durationMs: number
      readonly parts: ReadonlyArray<IndexedMessagePart>
    }

export function assistantPresentation(message: Message, showElapsedTime = true): AssistantPresentation {
  const parts = message.parts.flatMap((part, index) => (isOwnPart(part) ? [{ part, index }] : []))
  if (
    message.role === "user" ||
    message.completedAt === null ||
    !showElapsedTime ||
    parts.every(({ part }) => part.type === "agent_switch" || part.type === "session_import")
  )
    return { kind: "inline", parts }
  const durationMs = Date.parse(message.completedAt) - Date.parse(message.createdAt)
  if (!(durationMs >= 0)) return { kind: "inline", parts }
  return { kind: "completed", durationMs, parts }
}

export const INLINE_TAIL_PARTS = 50

export function foldedParts(presentation: AssistantPresentation): ReadonlyArray<IndexedMessagePart> {
  return presentation.kind === "completed"
    ? collapsedParts(presentation.parts)
    : presentation.parts.slice(-INLINE_TAIL_PARTS)
}

export function presentationBlocks(parts: ReadonlyArray<IndexedMessagePart>): Array<TranscriptBlock> {
  const blocks: Array<TranscriptBlock> = []
  let start = 0
  let firstIndex = 0
  for (const [position, { index }] of parts.entries()) {
    if (position === start) firstIndex = index
    if (parts[position + 1]?.index === index + 1) continue
    blocks.push(
      ...groupToolCalls(
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
  if (totalSeconds === 0) return "<1s"
  if (totalSeconds < 60) return `${totalSeconds}s`
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  return hours > 0 ? `${hours}:${twoDigits(minutes)}:${twoDigits(seconds)}` : `${minutes}:${twoDigits(seconds)}`
}
