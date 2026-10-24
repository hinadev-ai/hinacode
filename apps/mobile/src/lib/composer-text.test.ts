import type { AgentCommand } from "@shared/agent.ts"
import { describe, expect, it } from "vitest"
import { composerSpans, keepSkillWhole } from "./composer-text"

const commands: AgentCommand[] = [
  { trigger: "/", name: "triage-issue", description: "", argumentHint: "", scope: "project" },
  { trigger: "/", name: "compact", description: "", argumentHint: "", builtin: true },
]
const known = {
  commands: new Set(["/triage-issue", "/compact"]),
  files: new Set(["src/login.ts"]),
  threads: new Set<string>(),
}

describe("composerSpans", () => {
  it("marks a leading skill, known mentions and code, and keeps every character", () => {
    const text = "/triage-issue the login fails, see @src/login.ts and `npm test`\n```\nnpm test\n```"
    const spans = composerSpans(text, commands, known)
    expect(spans.map((span) => span.text).join("")).toBe(text)
    expect(spans.filter((span) => span.kind !== "text")).toEqual([
      { kind: "skill", text: "/triage-issue" },
      { kind: "mention", text: "@src/login.ts" },
      { kind: "code", text: "`npm test`" },
      { kind: "code", text: "```\nnpm test\n```" },
    ])
  })

  it("leaves a built-in command and a skill that does not start the message as commands", () => {
    expect(composerSpans("/compact now", commands, known)[0]).toEqual({ kind: "command", text: "/compact" })
    expect(composerSpans("run /triage-issue", commands, known).at(-1)).toEqual({
      kind: "command",
      text: "/triage-issue",
    })
  })
})

describe("keepSkillWhole", () => {
  const before = "/triage-issue the login test"

  it("removes the whole skill when a deletion cuts into it, and keeps the text", () => {
    expect(keepSkillWhole(before, "/triage-issuethe login test", commands)).toBe("the login test")
    expect(keepSkillWhole(before, "/triage-isse the login test", commands)).toBe("the login test")
    expect(keepSkillWhole(before, "/triage-ogin test", commands)).toBe("ogin test")
  })

  it("leaves other edits alone", () => {
    expect(keepSkillWhole(before, "/triage-issue the login", commands)).toBe("/triage-issue the login")
    expect(keepSkillWhole(before, "/triage-issuex the login test", commands)).toBe("/triage-issuex the login test")
    expect(keepSkillWhole("/compact now", "/compac now", commands)).toBe("/compac now")
    expect(keepSkillWhole(before, "", commands)).toBe("")
  })
})
