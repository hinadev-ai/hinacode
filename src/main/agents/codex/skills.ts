import { basename, dirname } from "node:path"
import type { AgentCommand } from "../../../shared/agent.ts"
import { isCommandName } from "../../../shared/composerSyntax.ts"
import type { SkillMetadata, SkillScope, UserInput } from "./protocol.ts"

const commandScopes: Partial<Record<SkillScope, AgentCommand["scope"]>> = { user: "user", repo: "project" }

const typedName = (skill: SkillMetadata) => (isCommandName(skill.name) ? skill.name : basename(dirname(skill.path)))

export const toCommand = (skill: SkillMetadata): AgentCommand => {
  const scope = commandScopes[skill.scope]
  const name = typedName(skill)
  return {
    trigger: "$",
    name,
    ...(name !== skill.name && { label: skill.name }),
    description: skill.shortDescription ?? skill.description,
    argumentHint: "",
    ...(scope && { scope }),
  }
}

// FIXME: Codex expands a skill only when it arrives as its own input item next to the $name in the text
export const skillInputs = (text: string, skills: ReadonlyArray<SkillMetadata>): Array<UserInput> =>
  skills
    .filter((skill) => skill.enabled && text.includes(`$${typedName(skill)}`))
    .map((skill) => ({ type: "skill", name: skill.name, path: skill.path }))
