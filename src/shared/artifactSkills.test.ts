import { describe, expect, test } from "vitest"
import { parseArtifactSkill } from "./artifactSkills.ts"

describe("parseArtifactSkill", () => {
  test("reads the skill and the request after it", () => {
    expect(parseArtifactSkill("/artifact:doc audit the startup path")).toEqual({
      skill: "artifact:doc",
      request: "audit the startup path",
    })
    expect(parseArtifactSkill("  /artifact:writing\nrelease notes for v0.9\n")).toEqual({
      skill: "artifact:writing",
      request: "release notes for v0.9",
    })
  })

  test("takes a command alone as an empty request", () => {
    expect(parseArtifactSkill("/artifact:doc")).toEqual({ skill: "artifact:doc", request: "" })
  })

  test("ignores a command that is not at the start or is only a prefix of another name", () => {
    expect(parseArtifactSkill("please run /artifact:doc")).toBeNull()
    expect(parseArtifactSkill("/artifact:docs plan")).toBeNull()
    expect(parseArtifactSkill("/artifact:doc-review plan")).toBeNull()
    expect(parseArtifactSkill("/artifact plan")).toBeNull()
  })
})
