import type { Message, MessagePart } from "./domain.ts"
import type { PushEvent } from "./contract.ts"

const SUMMARY_KEYS = ["command", "file_path", "path", "pattern", "url", "description"]

export function toolSummary(input: unknown): { readonly key: string; readonly line: string } | null {
  if (typeof input !== "object" || input === null) return null
  const record = input as Record<string, unknown>
  for (const key of SUMMARY_KEYS) {
    const value = record[key]
    if (typeof value === "string") return { key, line: value.split("\n", 1)[0]! }
  }
  return null
}

function compactInput(input: unknown) {
  const summary = toolSummary(input)
  return summary === null ? {} : { [summary.key]: summary.line }
}

function compactPart(part: MessagePart): MessagePart {
  switch (part.type) {
    case "tool_call": {
      const { output: _output, input, ...rest } = part
      return { ...rest, input: compactInput(input) }
    }
    case "file_change":
      return part.diff === "" ? part : { ...part, diff: "" }
    default:
      return part
  }
}

export const compactMessage = (message: Message): Message => ({
  ...message,
  parts: compactParts(message.parts),
})

const compactParts = (parts: ReadonlyArray<MessagePart>) =>
  parts.filter((part) => part.type !== "tool_call" || part.parentCallId === undefined).map(compactPart)

export function compactPush(push: typeof PushEvent.Encoded): typeof PushEvent.Encoded {
  if (push.type === "message.created" || push.type === "message.updated")
    return { ...push, message: { ...push.message, parts: compactParts(push.message.parts) } }
  if (push.type !== "thread.event") return push
  const { event } = push
  switch (event.type) {
    case "tool_call_started":
      return { ...push, event: { ...event, input: compactInput(event.input) } }
    case "tool_call_finished":
      return { ...push, event: { ...event, output: "" } }
    case "file_changed":
      return { ...push, event: { ...event, diff: "" } }
    default:
      return push
  }
}

export const TRANSCRIPT_PAGE_BYTES = 64 * 1024

const encoder = new TextEncoder()
const utf8Bytes = (message: Message) => encoder.encode(JSON.stringify(message)).length

export function transcriptPage(
  messages: ReadonlyArray<Message>,
  before: string | undefined,
  budget = TRANSCRIPT_PAGE_BYTES,
): { readonly messages: ReadonlyArray<Message>; readonly hasEarlier: boolean } {
  const end = before === undefined ? messages.length : messages.findIndex((message) => message.id === before)
  if (end <= 0) return { messages: [], hasEarlier: false }
  let start = end - 1
  let bytes = "[]".length + utf8Bytes(messages[start]!)
  while (start > 0) {
    bytes += ",".length + utf8Bytes(messages[start - 1]!)
    if (bytes > budget) break
    start--
  }
  return { messages: messages.slice(start, end), hasEarlier: start > 0 }
}
