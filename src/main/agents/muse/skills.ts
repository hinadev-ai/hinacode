import type { AgentCommand } from "../../../shared/agent.ts"
import type { SkillCatalogEntry } from "./protocol.ts"

export const toCommand = (skill: SkillCatalogEntry): AgentCommand => ({
  trigger: "/",
  name: skill.selector,
  description: skill.description,
  argumentHint: skill.argumentHint ?? "",
  ...((skill.source === "user" || skill.source === "project") && { scope: skill.source }),
})

export interface SkillInvocation {
  readonly selector: string
  readonly arguments: string
}

const INVOCATION = /^\/([^\s]+)(?:\s+([\s\S]*))?$/

export const parseSkillInvocation = (prompt: string, selectors: ReadonlySet<string>): SkillInvocation | null => {
  const match = INVOCATION.exec(prompt.trimStart())
  if (match === null || !selectors.has(match[1]!)) return null
  return { selector: match[1]!, arguments: match[2] ?? "" }
}
