import type { ProviderId } from "../../shared/agent.ts"
import type { Message, MessagePart } from "../../shared/domain.ts"

/** Small against every agent's context window, so the new session has room to work before it compacts. */
const HANDOFF_TOKENS = 16_000
const TOOL_INPUT_LIMIT = 200

const agentName: Record<ProviderId, string> = { claude: "Claude Code", codex: "Codex", muse: "Muse Code" }

/**
 * A token is about 4 bytes of English and 3 bytes, one character, of Chinese or Japanese. Counting every 3 bytes
 * as a token overestimates English, so the estimate never runs past the budget.
 */
const estimateTokens = (text: string) => Math.ceil(Buffer.byteLength(text) / 3)

/** The end of `text` that fits in `tokens`, without a character cut in half at its start. */
const tail = (text: string, tokens: number) =>
  Buffer.from(text)
    .subarray(-Math.floor(tokens * 3))
    .toString()
    .replace(/^\uFFFD+/, "")

/** The start of `text` that fits in `tokens`, without a character cut in half at its end. */
const head = (text: string, tokens: number) =>
  Buffer.from(text)
    .subarray(0, Math.floor(tokens * 3))
    .toString()
    .replace(/\uFFFD+$/, "")

const clip = (text: string, limit: number) => (text.length <= limit ? text : `${text.slice(0, limit)}…`)

/** The input field that says what a call did, as the transcript search indexes it. */
const toolSubject = (input: unknown) => {
  if (typeof input === "object" && input !== null) {
    for (const key of ["command", "file_path", "notebook_path", "pattern", "path", "url", "query", "description"]) {
      const value = Reflect.get(input, key)
      if (typeof value === "string") return value
    }
  }
  return JSON.stringify(input) ?? ""
}

/** What the user or the agent said. Null for a part that is activity, or that the handoff leaves out. */
const renderSaid = (part: MessagePart): string | null => {
  switch (part.type) {
    case "text":
    case "questions":
      return part.text
    case "attachment":
      return `[attachment ${part.attachment.name} at ${part.attachment.path}]`
    case "agent_switch":
      return `[the conversation moved from ${agentName[part.from]} to ${agentName[part.to]} here]`
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

/** Keeps the message's newest activity that fits in `room` tokens, and counts the rest. */
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

/**
 * The prompt that starts a new session of `to` on a conversation that ran in another session, of `from` or of
 * `to` itself. `messages` is the transcript before `prompt`, oldest first.
 *
 * It keeps the first user message, which usually sets the task, in up to an eighth of `budget` tokens, and the
 * newest messages in the rest. Tool calls and edits, newest first, take up to a quarter of it;
 * older ones are counted instead, so the rest goes to what was said, which the new agent needs most.
 * A newest message larger than what is left keeps its end.
 */
export function handoffPrompt(input: {
  readonly messages: ReadonlyArray<Message>
  readonly from: ProviderId
  readonly to: ProviderId
  readonly prompt: string
  readonly budget?: number
}): string {
  const budget = input.budget ?? HANDOFF_TOKENS
  const opening = input.messages.find((message) => message.role === "user")
  const openingText = opening === undefined ? null : (renderMessage(opening, 0)?.text ?? null)
  const openingKept =
    openingText === null || estimateTokens(openingText) <= budget / 8
      ? openingText
      : `${head(openingText, budget / 8)}…`
  const kept: Array<string> = []
  let used = openingKept === null ? 0 : estimateTokens(openingKept)
  let activityUsed = 0
  let omitted = 0
  for (const message of input.messages.toReversed()) {
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
  const origin =
    input.from === input.to
      ? `This conversation ran in an earlier ${agentName[input.to]} session that you cannot resume.`
      : `This conversation started with ${agentName[input.from]} and continues with you. Tool names below are ${agentName[input.from]}'s and may differ from yours.`
  const transcript = [
    ...(openingKept === null ? [] : [openingKept]),
    ...(omitted > 0 ? [`[${omitted} messages left out here to fit]`] : []),
    ...kept,
  ]
  return [
    "<conversation_handoff>",
    [
      origin,
      "Here is the transcript so far, oldest first. It is context, not a new request. Tool output is left out, so read files again before you rely on them.",
    ].join(" "),
    "",
    transcript.join("\n\n"),
    "</conversation_handoff>",
    "",
    input.prompt,
  ].join("\n")
}
