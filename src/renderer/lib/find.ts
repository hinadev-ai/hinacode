import type { Message, MessagePart } from "../../shared/domain.ts"
import { assistantPresentation, presentationBlocks } from "./assistantPresentation.ts"
import { describeCommand, describeToolCall } from "./toolCall.ts"

type ToolCall = Extract<MessagePart, { type: "tool_call" }>

export interface FindMatch {
  readonly messageId: string
  readonly partIndex: number
  readonly offset: number
}

export interface FindRevealRequest {
  readonly id: number
  readonly match: FindMatch
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

export const findPattern = (query: string): RegExp | null =>
  query.trim() === "" ? null : new RegExp(escapeRegExp(query), "giu")

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
    case "compaction":
    case "agent_switch":
      return ""
  }
}

export interface CommandFindText {
  readonly distinctLabel: string | null
  readonly command: string
}

export function commandFindText(call: ToolCall): CommandFindText {
  const label = describeCommand(call)
  const { summary: command } = describeToolCall(call)
  return { distinctLabel: label === command ? null : label, command }
}

export const commandSearchText = ({ distinctLabel, command }: CommandFindText) =>
  distinctLabel === null ? command : `${command}\n${distinctLabel}`

const toolRowSearchText = (call: ToolCall) =>
  call.name === "Bash" ? commandSearchText(commandFindText(call)) : searchableText(call)

export function findMatches(messages: ReadonlyArray<Message>, query: string): Array<FindMatch> {
  const pattern = findPattern(query)
  if (pattern === null) return []
  const matches: Array<FindMatch> = []
  const search = (messageId: string, partIndex: number, text: string) => {
    for (const match of text.matchAll(pattern)) matches.push({ messageId, partIndex, offset: match.index })
  }
  for (const message of messages) {
    const { parts } = assistantPresentation(message)
    const writing = message.completedAt === null && parts.at(-1)?.part.type === "text"
    for (const block of presentationBlocks(writing ? parts.slice(0, -1) : parts)) {
      if (block.type === "part") {
        search(message.id, block.index, searchableText(block.part))
        continue
      }
      for (const [position, call] of block.calls.entries()) {
        search(message.id, block.index + position, toolRowSearchText(call))
      }
    }
  }
  return matches
}
