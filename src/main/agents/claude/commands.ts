import type { SlashCommand } from "@anthropic-ai/claude-agent-sdk"
import type { AgentCommand } from "../../../shared/agent.ts"

/** Claude Code reports where it found a skill only as the end of its description, such as `(user)`. */
const SCOPE = /\s*\((user|project)\)$/

/** A `supportedCommands` row as a composer completion, with the scope moved out of the description. */
export const toCommand = (command: SlashCommand): AgentCommand => {
  const scope = SCOPE.exec(command.description)?.[1]
  return {
    trigger: "/",
    name: command.name,
    description: command.description.replace(SCOPE, ""),
    argumentHint: command.argumentHint,
    ...(command.builtin === true && { builtin: true }),
    ...((scope === "user" || scope === "project") && { scope }),
  }
}

/** The `skillOverrides` flag setting that hides every user-level skill and command from the model and from `/`. */
export const hideUserCommands = (commands: ReadonlyArray<SlashCommand>): Record<string, "off"> =>
  Object.fromEntries(
    commands
      .map(toCommand)
      .filter((command) => command.scope === "user")
      .map((command) => [command.name, "off"]),
  )
