import { CHART_GUIDE } from "@hinacode/artifacts"
import { describe, expect, it } from "vitest"
import type { AgentCommand } from "../../shared/agent.ts"
import { DOCUMENT_COMMAND, expandDocumentCommand, withDocumentCommand } from "./document.ts"

const skill = (trigger: AgentCommand["trigger"], name: string): AgentCommand => ({
  trigger,
  name,
  description: "",
  argumentHint: "",
})

describe("expandDocumentCommand", () => {
  it("puts the guide before the request", () => {
    const expanded = expandDocumentCommand("/document Q3 sales\nby week")
    expect(expanded).toContain(CHART_GUIDE)
    expect(expanded.endsWith("</document-guide>\n\nQ3 sales\nby week")).toBe(true)
  })

  it("sends only the guide when nothing follows the command", () => {
    expect(expandDocumentCommand(" /document \n").endsWith("</document-guide>")).toBe(true)
  })

  it("leaves every other prompt as typed", () => {
    for (const prompt of ["/documents now", "/document-review", "write a /document", " document "]) {
      expect(expandDocumentCommand(prompt)).toBe(prompt)
    }
  })
})

describe("withDocumentCommand", () => {
  it("replaces a slash skill with the same name, because the prompt expands to the guide either way", () => {
    expect(withDocumentCommand([skill("/", "document"), skill("/", "docs")])).toStrictEqual([
      DOCUMENT_COMMAND,
      skill("/", "docs"),
    ])
  })

  it("keeps a skill of another trigger", () => {
    expect(withDocumentCommand([skill("$", "document")])).toStrictEqual([DOCUMENT_COMMAND, skill("$", "document")])
  })
})
