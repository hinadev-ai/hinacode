import type { Message, MessagePart } from "./domain.ts"

/**
 * Drops tool outputs and file diffs, which are most of a transcript's bytes. The phone asks for transcripts this
 * way because it never shows them.
 */
export function compactPart(part: MessagePart): MessagePart {
  switch (part.type) {
    case "tool_call": {
      if (part.output === undefined) return part
      const { output: _output, ...rest } = part
      return rest
    }
    case "file_change":
      return part.diff === "" ? part : { ...part, diff: "" }
    default:
      return part
  }
}

export const compactMessage = (message: Message): Message => ({ ...message, parts: message.parts.map(compactPart) })
