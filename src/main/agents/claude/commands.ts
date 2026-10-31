import type { SlashCommand } from "@anthropic-ai/claude-agent-sdk"
import type { AgentCommand } from "../../../shared/agent.ts"
import { isCommandName } from "../../../shared/composerSyntax.ts"

// FIXME: Claude Code reports a skill's scope only as a "(user)" or "(project)" suffix of its description
const SCOPE = /\s*\((user|project)\)$/

export const toCommand = (command: SlashCommand): AgentCommand => {
  const scope = SCOPE.exec(command.description)?.[1]
  const typed = isCommandName(command.name) ? command.name : command.aliases?.find(isCommandName)
  return {
    trigger: "/",
    name: typed ?? command.name,
    ...(typed !== undefined && typed !== command.name && { label: command.name }),
    description: command.description.replace(SCOPE, ""),
    argumentHint: command.argumentHint,
    ...(command.builtin === true && { builtin: true }),
    ...((scope === "user" || scope === "project") && { scope }),
  }
}

export const hideUserCommands = (commands: ReadonlyArray<SlashCommand>): Record<string, "off"> =>
  Object.fromEntries(
    commands
      .filter((command) => toCommand(command).scope === "user")
      .flatMap((command) => [command.name, ...(command.aliases ?? [])].map((name) => [name, "off"])),
  )
