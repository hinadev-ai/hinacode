import type { ReactNode } from "react"
import { RiSlashCommands2 } from "react-icons/ri"
import type { AgentCommand } from "../../shared/agent.ts"
import { SkillIcon } from "./icons/SkillIcon.tsx"

export const commandChipClass =
  "inline-flex items-baseline gap-1 rounded-md bg-syntax-token/12 px-1.5 font-medium whitespace-nowrap text-syntax-token"
const chipIconClass = "size-3.5 shrink-0 self-center"

export const chipIcon = (command: Pick<AgentCommand, "builtin">) =>
  command.builtin === true ? (
    <RiSlashCommands2 aria-hidden className={chipIconClass} />
  ) : (
    <SkillIcon className={chipIconClass} />
  )

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
