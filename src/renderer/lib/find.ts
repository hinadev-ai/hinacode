import type { Message, MessagePart } from "../../shared/domain.ts"
import { assistantPresentation, presentationBlocks } from "./assistantPresentation.ts"
import { describeCommand, describeToolCall, type SkillLabels, skillsUsed, skillUseText } from "./toolCall.ts"

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

export function searchableText(part: MessagePart, skillLabels: SkillLabels): string {
  switch (part.type) {
    case "text":
    case "questions":
      return part.text
    case "signed_out":
      return `${part.message}\n${part.loginCommand}`
    case "tool_call": {
      const skills = skillsUsed(part)
      if (skills !== null) return skillUseText(skills, skillLabels)
      if (part.name === "Bash") return commandSearchText(commandFindText(part))
      const { name, summary } = describeToolCall(part)
      return `${name}\n${summary}`
    }
    case "file_change":
      return part.path
    case "reasoning":
    case "attachment":
    case "compaction":
    case "agent_switch":
    case "session_import":
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

export function findMatches(
  messages: ReadonlyArray<Message>,
  query: string,
  skillLabels: SkillLabels = new Map(),
): Array<FindMatch> {
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
        search(message.id, block.index, searchableText(block.part, skillLabels))
        continue
      }
      for (const [position, part] of block.parts.entries()) {
        search(message.id, block.index + position, searchableText(part, skillLabels))
      }
    }
  }
  return matches
}
