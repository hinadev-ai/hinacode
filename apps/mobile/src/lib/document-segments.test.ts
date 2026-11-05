import { describe, expect, it } from "vitest"
import { documentSegments } from "./document-segments"

describe("documentSegments", () => {
  it("splits a document into Markdown and callouts", () => {
    const markdown = "# Plan\n\nIntro.\n\n> [!NOTE]\n> Ship **Friday**.\n>\n> Second paragraph.\n\n## Next\n\nMore."
    expect(documentSegments(markdown)).toEqual([
      { kind: "markdown", text: "# Plan\n\nIntro." },
      { kind: "callout", tone: "note", text: "Ship **Friday**.\n\nSecond paragraph." },
      { kind: "markdown", text: "## Next\n\nMore." },
    ])
  })

  it("reads every tone and ignores the marker's case", () => {
    const tones = ["note", "TIP", "Important", "warning", "CAUTION"].map((tone) => `> [!${tone}]\n> Body.`)
    expect(documentSegments(tones.join("\n\n")).map((segment) => (segment.kind === "callout" ? segment.tone : ""))).toEqual(
      ["note", "tip", "important", "warning", "caution"],
    )
  })

  it("keeps a marker inside a code fence as code, with either fence", () => {
    const backticks = "```markdown\n> [!NOTE]\n> Not a callout.\n```"
    const tildes = "~~~text\n> [!WARNING]\n```\n~~~"
    expect(documentSegments(backticks)).toEqual([{ kind: "markdown", text: backticks }])
    expect(documentSegments(tildes)).toEqual([{ kind: "markdown", text: tildes }])
  })

  it("keeps a quote whose marker shares its line as a quote, and a plain quote", () => {
    const shared = "> [!NOTE] Same line.\n> More."
    expect(documentSegments(shared)).toEqual([{ kind: "markdown", text: shared }])
    expect(documentSegments("> Just a quote.")).toEqual([{ kind: "markdown", text: "> Just a quote." }])
  })

  it("keeps a callout with no body", () => {
    expect(documentSegments("> [!TIP]")).toEqual([{ kind: "callout", tone: "tip", text: "" }])
  })

  it("keeps code inside a callout", () => {
    expect(documentSegments("> [!NOTE]\n> ```ts\n> const a = 1\n> ```")).toEqual([
      { kind: "callout", tone: "note", text: "```ts\nconst a = 1\n```" },
    ])
  })

  it("does not open a fence on a line of inline code", () => {
    expect(documentSegments("```inline``` text\n\n> [!NOTE]\n> Body.").map(({ kind }) => kind)).toEqual([
      "markdown",
      "callout",
    ])
  })

  it("runs an unclosed fence to the end", () => {
    const unclosed = "```text\n> [!NOTE]\nstill code"
    expect(documentSegments(unclosed)).toEqual([{ kind: "markdown", text: unclosed }])
  })

  it("draws a valid chart as its title, notes and table", () => {
    const chart = JSON.stringify({
      type: "bar",
      title: "Daily sales",
      notes: "Five days",
      x: "day",
      series: [{ key: "chat", label: "Chat | live" }, { key: "drama" }],
      unit: { prefix: "¥" },
      rows: [
        { day: "10-15", chat: 25875, drama: 18700.5 },
        { day: "10-16", chat: null },
      ],
    })
    expect(documentSegments(`\`\`\`chart\n${chart}\n\`\`\``)).toEqual([
      {
        kind: "markdown",
        text: [
          "**Daily sales**",
          "",
          "Five days",
          "",
          "| day | Chat \\| live | drama |",
          "| --- | ---: | ---: |",
          "| 10-15 | ¥25,875 | ¥18,700.5 |",
          "| 10-16 |  |  |",
        ].join("\n"),
      },
    ])
  })

  it("leaves an invalid chart and a mermaid diagram as code", () => {
    const invalid = '```chart\n{"type":"pie"}\n```'
    const diagram = "```mermaid\nflowchart TD\n  A --> B\n```"
    expect(documentSegments(invalid)).toEqual([{ kind: "markdown", text: invalid }])
    expect(documentSegments(diagram)).toEqual([{ kind: "markdown", text: diagram }])
  })

  it("resolves a footnote cited in one segment and defined past a callout", () => {
    const text = documentSegments("Claim[^a].\n\n> [!NOTE]\n> Aside.\n\nEnd.\n\n[^a]: Source.")
      .map((segment) => segment.text)
      .join("\n")
    expect(text).toContain("Claim¹.")
    expect(text).toContain("1. Source.")
  })

  it("keeps CRLF documents and every character of a long one", () => {
    expect(documentSegments("Intro.\r\n\r\n> [!TIP]\r\n> Body.\r\n")).toEqual([
      { kind: "markdown", text: "Intro." },
      { kind: "callout", tone: "tip", text: "Body." },
    ])
    const paragraph = `${"word ".repeat(40).trim()}\n\n`
    const long = paragraph.repeat(1000)
    const segments = documentSegments(long)
    expect(segments.length).toBeGreaterThan(10)
    expect(segments.map((segment) => segment.text).join("\n\n")).toBe(long.trimEnd())
  })

  it("does not break a long segment inside a list", () => {
    const item = `- ${"word ".repeat(40).trim()}\n\n`
    expect(documentSegments(item.repeat(300))).toHaveLength(1)
  })

  it("is empty for an empty document", () => {
    expect(documentSegments("")).toEqual([])
    expect(documentSegments("\n\n  \n")).toEqual([])
  })
})
