import type { Message, MessagePart } from "../../shared/domain.ts"
import { isOwnPart } from "./subagents.ts"
import { describeCommand, describeToolCall, groupCommands } from "./toolCall.ts"

type ToolCall = Extract<MessagePart, { type: "tool_call" }>

export interface FindMatch {
  readonly messageId: string
  /** Index among the parts the transcript renders, which leaves out sub-agent calls. */
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

/**
 * A command folded into a group shows its row label, then, once its row opens, the command itself when
 * the label is the agent's description of it.
 */
export function commandSearchText(call: ToolCall): string {
  const label = describeCommand(call)
  const { summary: command } = describeToolCall(call)
  return label === command ? label : `${label}\n${command}`
}

/** Every match of `query` in the transcript, in reading order. */
export function findMatches(messages: ReadonlyArray<Message>, query: string): Array<FindMatch> {
  const pattern = findPattern(query)
  if (pattern === null) return []
  const matches: Array<FindMatch> = []
  const search = (messageId: string, partIndex: number, text: string) => {
    for (const match of text.matchAll(pattern)) matches.push({ messageId, partIndex, offset: match.index })
  }
  for (const message of messages) {
    const parts = message.parts.filter(isOwnPart)
    // Reply text appears only once the agent finishes it, so the part still being written is not on screen.
    const writing = message.completedAt === null && parts.at(-1)?.type === "text"
    for (const block of groupCommands(writing ? parts.slice(0, -1) : parts)) {
      if (block.type === "part") search(message.id, block.index, searchableText(block.part))
      else block.calls.forEach((call, position) => search(message.id, block.index + position, commandSearchText(call)))
    }
  }
  return matches
}
