import type { AgentCommand } from "../../shared/agent.ts"
import { ARTIFACT_SKILLS, type ArtifactSkill } from "../../shared/artifactSkills.ts"
import { m } from "../paraglide/messages.js"

const copy = {
  "artifact:doc": { description: m.artifact_doc_command_description, hint: m.artifact_doc_command_hint },
  "artifact:writing": { description: m.artifact_writing_command_description, hint: m.artifact_writing_command_hint },
} satisfies Record<ArtifactSkill, { description: () => string; hint: () => string }>

export const artifactSkillCommands = (): ReadonlyArray<AgentCommand> =>
  ARTIFACT_SKILLS.map((name) => ({
    trigger: "/",
    name,
    description: copy[name].description(),
    argumentHint: copy[name].hint(),
  }))
