import type { Message, MessagePart } from "../../shared/domain.ts"
import { assistantPresentation } from "./assistantPresentation.ts"
import { describeToolCall } from "./toolCall.ts"

export interface FindMatch {
  readonly messageId: string
  readonly partIndex: number
  /** UTF-16 offset of the match in the part's searchable text. */
  readonly offset: number
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/** Matches `query` literally and case-insensitively. Null for a blank query, which matches nothing. */
export const findPattern = (query: string): RegExp | null =>
  query.trim() === "" ? null : new RegExp(escapeRegExp(query), "giu")

/**
 * The text of a part a reader sees without expanding anything. Reasoning, tool input and output, and
 * diffs sit behind a disclosure, so they are not searched.
 */
export function searchableText(part: MessagePart): string {
  switch (part.type) {
    case "text":
    case "questions":
      return part.text
    case "tool_call": {
      const { name, summary } = describeToolCall(part)
      return `${name}\n${summary}`
    }
    case "file_change":
      return part.path
    case "reasoning":
    case "attachment":
      return ""
  }
}

/** Every match of `query` in the transcript, in reading order. */
export function findMatches(messages: ReadonlyArray<Message>, query: string): Array<FindMatch> {
  const pattern = findPattern(query)
  if (pattern === null) return []
  const matches: Array<FindMatch> = []
  for (const message of messages) {
    const presentation = assistantPresentation(message)
    const parts = presentation.kind === "completed" ? [...presentation.work, ...presentation.reply] : presentation.parts
    // Reply text appears only once the agent finishes it, so the part still being written is not on screen.
    const writing = message.completedAt === null && parts.at(-1)?.part.type === "text"
    const searchedParts = writing ? parts.slice(0, -1) : parts
    for (const { part, index: partIndex } of searchedParts) {
      for (const match of searchableText(part).matchAll(pattern)) {
        matches.push({ messageId: message.id, partIndex, offset: match.index })
      }
    }
  }
  return matches
}
