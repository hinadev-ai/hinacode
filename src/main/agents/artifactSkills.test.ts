import { CHART_GUIDE } from "@hinacode/artifacts"
import { describe, expect, test } from "vitest"
import { expandArtifactSkill } from "./artifactSkills.ts"
import { DOCUMENT_TEMPLATES } from "./documentTemplates.ts"

const titlesOutsideFences = (markdown: string) => {
  let inFence = false
  return markdown.split("\n").filter((line) => {
    if (line.startsWith("```")) inFence = !inFence
    return !inFence && line.startsWith("# ")
  })
}

describe("expandArtifactSkill", () => {
  test("leaves a prompt without a skill alone", () => {
    expect(expandArtifactSkill("fix the build")).toBe("fix the build")
    expect(expandArtifactSkill("write /artifact:doc later")).toBe("write /artifact:doc later")
  })

  test("puts the skill's instructions before the request", () => {
    const prompt = expandArtifactSkill("/artifact:writing release notes for v0.9")
    expect(prompt).toMatch(/^<hinacode-skill name="artifact:writing">\nWrite a piece of prose/)
    expect(prompt).toMatch(/<\/hinacode-skill>\n\n<request>\nrelease notes for v0.9\n<\/request>$/)
  })

  test("asks for the conversation so far when the request is empty", () => {
    expect(expandArtifactSkill("/artifact:doc")).toContain(
      "<request>\nTurn the work in this conversation so far into a document.\n</request>",
    )
  })

  test("offers every template to the document skill and none to the writing skill", () => {
    const doc = expandArtifactSkill("/artifact:doc x")
    const writing = expandArtifactSkill("/artifact:writing x")
    for (const { id } of DOCUMENT_TEMPLATES) {
      expect(doc).toContain(`(\`${id}\`)`)
      expect(writing).not.toContain(`(\`${id}\`)`)
    }
  })
})

describe("chart syntax in skills", () => {
  test("gives the document skill the chart guide and no tool to fetch it", () => {
    const doc = expandArtifactSkill("/artifact:doc x")
    expect(doc).toContain(CHART_GUIDE)
    expect(doc).not.toContain("document_chart_guide")
  })

  test("costs other prompts nothing", () => {
    expect(expandArtifactSkill("fix the build")).not.toContain(CHART_GUIDE)
    expect(expandArtifactSkill("/artifact:writing x")).not.toContain(CHART_GUIDE)
  })
})

describe("DOCUMENT_TEMPLATES", () => {
  test("have unique ids and one title each, outside code fences", () => {
    expect(new Set(DOCUMENT_TEMPLATES.map((template) => template.id)).size).toBe(DOCUMENT_TEMPLATES.length)
    for (const { id, markdown } of DOCUMENT_TEMPLATES) {
      expect(titlesOutsideFences(markdown), id).toHaveLength(1)
      expect(markdown.startsWith("# "), id).toBe(true)
    }
  })

  test("never close the fence the skill wraps them in", () => {
    for (const { id, markdown } of DOCUMENT_TEMPLATES) expect(markdown, id).not.toContain("~~~")
  })
})
