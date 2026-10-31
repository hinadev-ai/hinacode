import type { AgentCommand } from "../../shared/agent.ts"

export const COMPACT_COMMAND: AgentCommand = {
  trigger: "/",
  name: "compact",
  description: "Free up context by summarizing the conversation so far",
  argumentHint: "",
  builtin: true,
}

export const isCompactCommand = (prompt: string) => prompt.trim() === "/compact"
