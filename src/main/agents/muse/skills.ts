import type { AgentCommand } from "../../../shared/agent.ts"
import type { SkillCatalogEntry } from "./protocol.ts"

/** A `skill/list` row as a composer completion: Muse skills are typed as `/selector`. */
export const toCommand = (skill: SkillCatalogEntry): AgentCommand => ({
  trigger: "/",
  name: skill.selector,
  description: skill.description,
  argumentHint: skill.argumentHint ?? "",
  ...((skill.source === "user" || skill.source === "project") && { scope: skill.source }),
})

export interface SkillInvocation {
  readonly selector: string
  /** Everything after the shortcut token, or "" when the prompt is only the token. */
  readonly arguments: string
}

const INVOCATION = /^\/([^\s]+)(?:\s+([\s\S]*))?$/

/**
 * Splits a prompt that starts with a known `/selector` into the invocation the host expands.
 * Anything else, including an unknown selector, stays plain text.
 */
export const parseSkillInvocation = (prompt: string, selectors: ReadonlySet<string>): SkillInvocation | null => {
  const match = INVOCATION.exec(prompt.trimStart())
  if (match === null || !selectors.has(match[1]!)) return null
  return { selector: match[1]!, arguments: match[2] ?? "" }
}
