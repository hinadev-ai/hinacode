import type { AgentCommand } from "../../../shared/agent.ts"
import type { SkillMetadata, SkillScope, UserInput } from "./protocol.ts"

const commandScopes: Partial<Record<SkillScope, AgentCommand["scope"]>> = { user: "user", repo: "project" }

export const toCommand = (skill: SkillMetadata): AgentCommand => {
  const scope = commandScopes[skill.scope]
  return {
    trigger: "$",
    name: skill.name,
    description: skill.shortDescription ?? skill.description,
    argumentHint: "",
    ...(scope && { scope }),
  }
}

// FIXME: Codex expands a skill only when it arrives as its own input item next to the $name in the text
export const skillInputs = (text: string, skills: ReadonlyArray<SkillMetadata>): Array<UserInput> =>
  skills
    .filter((skill) => skill.enabled && text.includes(`$${skill.name}`))
    .map((skill) => ({ type: "skill", name: skill.name, path: skill.path }))
