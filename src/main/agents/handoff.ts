import type { ProviderId } from "../../shared/agent.ts"
import type { Message, MessagePart } from "../../shared/domain.ts"
import { providerCli } from "../../shared/providers.ts"

const HANDOFF_TOKENS = 16_000
const TOOL_INPUT_LIMIT = 200

const estimateTokens = (text: string) => Math.ceil(Buffer.byteLength(text) / 3)

const tail = (text: string, tokens: number) =>
  Buffer.from(text)
    .subarray(-Math.floor(tokens * 3))
    .toString()
    .replace(/^\uFFFD+/, "")

const head = (text: string, tokens: number) =>
  Buffer.from(text)
    .subarray(0, Math.floor(tokens * 3))
    .toString()
    .replace(/\uFFFD+$/, "")

const clip = (text: string, limit: number) => (text.length <= limit ? text : `${text.slice(0, limit)}…`)

const toolSubject = (input: unknown) => {
  if (typeof input === "object" && input !== null) {
    for (const key of ["command", "file_path", "notebook_path", "pattern", "path", "url", "query", "description"]) {
      const value = Reflect.get(input, key)
      if (typeof value === "string") return value
    }
  }
  return JSON.stringify(input) ?? ""
}

const renderSaid = (part: MessagePart): string | null => {
  switch (part.type) {
    case "text":
    case "questions":
      return part.text
    case "attachment":
      return `[attachment ${part.attachment.name} at ${part.attachment.path}]`
    case "agent_switch":
      return `[the conversation moved from ${providerCli[part.from].name} to ${providerCli[part.to].name} here]`
    default:
      return null
  }
}

const renderActivity = (part: MessagePart): string | null => {
  switch (part.type) {
    case "tool_call":
      return part.parentCallId === undefined
        ? `[tool ${part.name}: ${part.status}] ${clip(toolSubject(part.input), TOOL_INPUT_LIMIT)}`
        : null
    case "file_change":
      return `[edited ${part.path}]`
    case "compaction":
      return part.compaction.status === "done" ? "[the agent compacted its context here]" : null
    default:
      return null
  }
}

const renderMessage = (message: Message, room: number) => {
  const lines: Array<string> = []
  let activityTokens = 0
  let dropped = 0
  for (const part of message.parts.toReversed()) {
    const said = renderSaid(part)
    if (said !== null) {
      lines.unshift(said)
      continue
    }
    const activity = renderActivity(part)
    if (activity === null) continue
    const tokens = estimateTokens(activity)
    if (dropped === 0 && activityTokens + tokens <= room) {
      lines.unshift(activity)
      activityTokens += tokens
    } else dropped++
  }
  if (dropped > 0) lines.unshift(`[${dropped} earlier tool calls and edits left out]`)
  return lines.length === 0 ? null : { text: [`## ${message.role}`, ...lines].join("\n"), activityTokens }
}

export function renderTranscript(messages: ReadonlyArray<Message>, budget = HANDOFF_TOKENS): string {
  const opening = messages.find((message) => message.role === "user")
  const openingText = opening === undefined ? null : (renderMessage(opening, 0)?.text ?? null)
  const openingKept =
    openingText === null || estimateTokens(openingText) <= budget / 8
      ? openingText
      : `${head(openingText, budget / 8)}…`
  const kept: Array<string> = []
  let used = openingKept === null ? 0 : estimateTokens(openingKept)
  let activityUsed = 0
  let omitted = 0
  for (const message of messages.toReversed()) {
    if (message === opening) continue
    const rendered = renderMessage(message, budget / 4 - activityUsed)
    if (rendered === null) continue
    const tokens = estimateTokens(rendered.text)
    if (omitted > 0 || used + tokens > budget) {
      if (kept.length === 0 && omitted === 0) {
        kept.push(`…${tail(rendered.text, budget - used)}`)
        used = budget
      } else omitted++
      continue
    }
    kept.unshift(rendered.text)
    used += tokens
    activityUsed += rendered.activityTokens
  }
  return [
    ...(openingKept === null ? [] : [openingKept]),
    ...(omitted > 0 ? [`[${omitted} messages left out here to fit]`] : []),
    ...kept,
  ].join("\n\n")
}

export function handoffPrompt(input: {
  readonly messages: ReadonlyArray<Message>
  readonly from: ProviderId
  readonly to: ProviderId
  readonly prompt: string
  readonly budget?: number
}): string {
  const origin =
    input.from === input.to
      ? `This conversation ran in an earlier ${providerCli[input.to].name} session that you cannot resume.`
      : `This conversation started with ${providerCli[input.from].name} and continues with you. Tool names below are ${providerCli[input.from].name}'s and may differ from yours.`
  return [
    "<conversation_handoff>",
    [
      origin,
      "Here is the transcript so far, oldest first. It is context, not a new request. Tool output is left out, so read files again before you rely on them.",
    ].join(" "),
    "",
    renderTranscript(input.messages, input.budget),
    "</conversation_handoff>",
    "",
    input.prompt,
  ].join("\n")
}
