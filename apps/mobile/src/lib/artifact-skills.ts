import type { AgentCommand } from "@shared/agent.ts"
import { ARTIFACT_SKILLS, type ArtifactSkill } from "@shared/artifactSkills.ts"
import { copy } from "./copy"

const texts = {
  "artifact:doc": { description: copy("mobile_artifact_doc_description"), hint: copy("mobile_artifact_doc_hint") },
  "artifact:writing": {
    description: copy("mobile_artifact_writing_description"),
    hint: copy("mobile_artifact_writing_hint"),
  },
} satisfies Record<ArtifactSkill, { description: string; hint: string }>

export const artifactSkillCommands: readonly AgentCommand[] = ARTIFACT_SKILLS.map((name) => ({
  trigger: "/",
  name,
  description: texts[name].description,
  argumentHint: texts[name].hint,
}))
