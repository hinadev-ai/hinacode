export const ARTIFACT_SKILLS = ["artifact:doc", "artifact:writing"] as const

export type ArtifactSkill = (typeof ARTIFACT_SKILLS)[number]

interface ArtifactSkillInvocation {
  readonly skill: ArtifactSkill
  readonly request: string
}

const INVOCATION = new RegExp(String.raw`^\s*/(${ARTIFACT_SKILLS.join("|")})(?![\w:.-])([\s\S]*)$`)

export const parseArtifactSkill = (prompt: string): ArtifactSkillInvocation | null => {
  const match = INVOCATION.exec(prompt)
  if (match === null) return null
  return { skill: match[1] as ArtifactSkill, request: (match[2] ?? "").trim() }
}
