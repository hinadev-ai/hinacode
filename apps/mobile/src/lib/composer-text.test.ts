import type { AgentCommand } from "@shared/agent.ts"
import { matchCommands } from "@shared/composerSyntax.ts"
import { describe, expect, it } from "vitest"
import { artifactSkillCommands } from "./artifact-skills"
import { composerDecorations, composerSpans, formatSelection, keepSkillWhole } from "./composer-text"

const commands: AgentCommand[] = [
  { trigger: "/", name: "triage-issue", description: "", argumentHint: "", scope: "project" },
  { trigger: "/", name: "compact", description: "", argumentHint: "", builtin: true },
]
const known = {
  commands: new Set(["/triage-issue", "/compact"]),
  files: new Set(["src/login.ts"]),
  threads: new Set<string>(),
  terminals: new Set<string>(),
  artifacts: new Set<string>(),
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
      artifacts: new Set<string>(),
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

describe("composerDecorations", () => {
  it("draws commands and skills as chips with the desktop's icon, over the same offsets as the text", () => {
    const text = "/triage-issue run /compact on @src/login.ts and `npm test`"
    expect(composerDecorations(text, commands, known)).toEqual([
      { kind: "chip", start: 0, end: 13, icon: "skill" },
      { kind: "chip", start: 18, end: 26, icon: "slash" },
      { kind: "token", start: 30, end: 43 },
      { kind: "code", start: 48, end: 58 },
    ])
  })
})

describe("composerDecorations for prose", () => {
  const kinds = (text: string) =>
    composerDecorations(text, commands, known).map((d) => `${d.kind}:${text.slice(d.start, d.end)}`)

  it("bolds between muted markers", () => {
    expect(kinds("a **big** deal")).toEqual(["muted:**", "strong:big", "muted:**"])
  })

  it("italicizes *emphasis* but leaves multiplication, a_b and *args alone", () => {
    expect(kinds("an *odd* one")).toEqual(["muted:*", "emphasis:odd", "muted:*"])
    expect(kinds("a * b * c and a_b and f(*args, **kw)")).toEqual([])
  })

  it("tints a Markdown link's label and a bare URL, without trailing punctuation", () => {
    expect(kinds("see [the docs](https://x.dev/a) or https://x.dev/b.")).toEqual([
      "muted:[",
      "link:the docs",
      "muted:](https://x.dev/a)",
      "link:https://x.dev/b",
    ])
  })
})

describe("formatSelection", () => {
  it("wraps a selection in bold markers and keeps it selected", () => {
    expect(formatSelection("make it bold", { start: 8, end: 12 }, "strong")).toEqual({
      text: "make it **bold**",
      selection: { start: 10, end: 14 },
    })
  })

  it("unwraps a selection that already has the markers", () => {
    expect(formatSelection("make it **bold**", { start: 10, end: 14 }, "strong")).toEqual({
      text: "make it bold",
      selection: { start: 8, end: 12 },
    })
    expect(formatSelection("an *odd* one", { start: 4, end: 7 }, "emphasis")).toEqual({
      text: "an odd one",
      selection: { start: 3, end: 6 },
    })
  })

  it("does not take bold markers for italic ones", () => {
    expect(formatSelection("**x**", { start: 2, end: 3 }, "emphasis").text).toBe("***x***")
  })

  it("makes the selection a link label and puts the caret where the URL goes", () => {
    expect(formatSelection("read the docs", { start: 5, end: 13 }, "link")).toEqual({
      text: "read [the docs]()",
      selection: { start: 16, end: 16 },
    })
  })
})
