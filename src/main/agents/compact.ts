import type { AgentCommand } from "../../shared/agent.ts"

/**
 * Claude Code runs `/compact` itself. Codex and Muse compact through a protocol call instead, so their
 * providers offer this command and turn a prompt of just `/compact` into that call.
 */
export const COMPACT_COMMAND: AgentCommand = {
  trigger: "/",
  name: "compact",
  description: "Free up context by summarizing the conversation so far",
  argumentHint: "",
  builtin: true,
}

export const isCompactCommand = (prompt: string) => prompt.trim() === "/compact"
