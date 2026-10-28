import type { ProviderId } from "../../shared/agent.ts"
import type { Message, MessagePart } from "../../shared/domain.ts"

/** About 15K tokens: enough for the recent work, small against every agent's context window. */
export const HANDOFF_BUDGET = 60_000
const TOOL_INPUT_LIMIT = 200

const agentName: Record<ProviderId, string> = { claude: "Claude Code", codex: "Codex", muse: "Muse Code" }

const clip = (text: string, limit: number) => (text.length <= limit ? text : `${text.slice(0, limit)}…`)

const renderPart = (part: MessagePart): string | null => {
  switch (part.type) {
    case "text":
    case "questions":
      return part.text
    case "reasoning":
      return null
    case "tool_call":
      return part.parentCallId === undefined
        ? `[tool ${part.name}: ${part.status}] ${clip(JSON.stringify(part.input) ?? "", TOOL_INPUT_LIMIT)}`
        : null
    case "file_change":
      return `[edited ${part.path}]`
    case "attachment":
      return `[attachment ${part.attachment.name} at ${part.attachment.path}]`
    case "compaction":
      return part.compaction.status === "done" ? "[the agent compacted its context here]" : null
    case "agent_switch":
      return `[the conversation moved from ${agentName[part.from]} to ${agentName[part.to]} here]`
  }
}

const renderMessage = (message: Message) => {
  const body = message.parts.flatMap((part) => renderPart(part) ?? [])
  return body.length === 0 ? null : [`## ${message.role}`, ...body].join("\n")
}

/**
 * The prompt that starts a new session of `to` on a conversation that ran in another session, of `from` or of
 * `to` itself. `messages` is the transcript before `prompt`, oldest first. The newest messages that fit in
 * `budget` characters are kept whole, except a newest one that alone is larger, which keeps its end.
 */
export function handoffPrompt(input: {
  readonly messages: ReadonlyArray<Message>
  readonly from: ProviderId
  readonly to: ProviderId
  readonly prompt: string
  readonly budget?: number
}): string {
  const budget = input.budget ?? HANDOFF_BUDGET
  const rendered = input.messages.flatMap((message) => renderMessage(message) ?? [])
  const kept: Array<string> = []
  let used = 0
  for (const message of rendered.toReversed()) {
    if (used + message.length > budget) {
      if (kept.length === 0) kept.push(`…${message.slice(message.length - budget)}`)
      break
    }
    kept.unshift(message)
    used += message.length
  }
  const omitted = rendered.length - kept.length
  const origin =
    input.from === input.to
      ? `This conversation ran in an earlier ${agentName[input.to]} session that you cannot resume.`
      : `This conversation started with ${agentName[input.from]} and continues with you. Tool names below are ${agentName[input.from]}'s and may differ from yours.`
  return [
    "<conversation_handoff>",
    `${origin} Here is the transcript so far, oldest first. It is context, not a new request. Tool output is left out, so read files again before you rely on them.${omitted > 0 ? ` ${omitted} older messages were left out to fit.` : ""}`,
    "",
    kept.join("\n\n"),
    "</conversation_handoff>",
    "",
    input.prompt,
  ].join("\n")
}
