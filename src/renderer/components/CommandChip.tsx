import type { ReactNode } from "react"
import type { AgentCommand } from "../../shared/agent.ts"
import { SkillIcon, skillIconShape } from "./icons/SkillIcon.tsx"
import { SlashIcon, slashIconShape } from "./icons/SlashIcon.tsx"

export const commandChipClass =
  "inline-flex items-baseline gap-1 rounded-md bg-syntax-token/12 px-1.5 font-medium whitespace-nowrap text-syntax-token"
export const chipIconClass = "size-3.5 shrink-0 self-center"

export const chipIcon = (command: Pick<AgentCommand, "builtin">) =>
  command.builtin === true ? (
    <SlashIcon aria-hidden className={chipIconClass} />
  ) : (
    <SkillIcon className={chipIconClass} />
  )

export const chipIconShape = (command: Pick<AgentCommand, "builtin">) =>
  command.builtin === true ? slashIconShape : skillIconShape

export function CommandChip({
  command,
  children,
}: {
  command: Pick<AgentCommand, "trigger" | "builtin">
  children: ReactNode
}) {
  return (
    <span data-kind="command" className={commandChipClass}>
      {chipIcon(command)}
      <span className="sr-only">{command.trigger}</span>
      {children}
    </span>
  )
}
