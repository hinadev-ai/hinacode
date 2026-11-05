import { describe, expect, test } from "@effect/vitest"
import type { SkillMetadata } from "./protocol.ts"
import { skillInputs, toCommand } from "./skills.ts"

const createPr: SkillMetadata = {
  name: "Create PR",
  description: "Open a pull request.",
  path: "/home/u/.agents/skills/create-pr/SKILL.md",
  scope: "user",
  enabled: true,
}

describe("toCommand", () => {
  test("types a skill by its name, or by its folder when the name has spaces", () => {
    expect(toCommand({ ...createPr, name: "review", path: "/home/u/.agents/skills/review/SKILL.md" }).name).toBe(
      "review",
    )
    expect(toCommand(createPr)).toStrictEqual({
      trigger: "$",
      name: "create-pr",
      label: "Create PR",
      description: "Open a pull request.",
      argumentHint: "",
      scope: "user",
    })
  })
})

describe("skillInputs", () => {
  test("sends the skill whose typed $name is in the text", () => {
    expect(skillInputs("open $create-pr for this", [createPr])).toStrictEqual([
      { type: "skill", name: "Create PR", path: createPr.path },
    ])
    expect(skillInputs("no skill here", [createPr])).toStrictEqual([])
  })
})
