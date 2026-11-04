import type { AgentCommand } from "@shared/agent.ts"
import { matchCommands } from "@shared/composerSyntax.ts"
import { describe, expect, it } from "vitest"
import { artifactSkillCommands } from "./artifact-skills"
import { composerSpans, keepSkillWhole } from "./composer-text"

const commands: AgentCommand[] = [
  { trigger: "/", name: "triage-issue", description: "", argumentHint: "", scope: "project" },
  { trigger: "/", name: "compact", description: "", argumentHint: "", builtin: true },
]
const known = {
  commands: new Set(["/triage-issue", "/compact"]),
  files: new Set(["src/login.ts"]),
  threads: new Set<string>(),
  terminals: new Set<string>(),
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

describe("artifact skills", () => {
  it("lists both with their hints without any command from the agent", () => {
    const listed = matchCommands(artifactSkillCommands, { trigger: "/", query: "art", start: 0, end: 4 })
    expect(listed.map(({ name, argumentHint }) => [name, argumentHint])).toEqual([
      ["artifact:doc", "[what to document]"],
      ["artifact:writing", "[what to write]"],
    ])
  })

  it("tints one at the start of a message and removes it whole", () => {
    const noTokens = {
      commands: new Set<string>(),
      files: new Set<string>(),
      threads: new Set<string>(),
      terminals: new Set<string>(),
    }
    expect(composerSpans("/artifact:doc Release plan", artifactSkillCommands, noTokens)[0]).toEqual({
      kind: "skill",
      text: "/artifact:doc",
    })
    expect(keepSkillWhole("/artifact:doc Release plan", "/artifact:do Release plan", artifactSkillCommands)).toBe(
      "Release plan",
    )
  })
})
