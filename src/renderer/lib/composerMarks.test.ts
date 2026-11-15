import { describe, expect, test } from "@effect/vitest"
import type { AgentCommand } from "../../shared/agent.ts"
import { composerMarks } from "./composerMarks.ts"

const command = (name: string, builtin?: true): AgentCommand => ({
  trigger: "/",
  name,
  description: "",
  argumentHint: "",
  ...(builtin ? { builtin } : {}),
})
const commands = [command("kalan-mode"), command("code-review"), command("compact", true)]
const known = {
  commands: new Set(commands.map((each) => `/${each.name}`)),
  files: new Set<string>(),
  threads: new Set<string>(),
  terminals: new Set<string>(),
  artifacts: new Set<string>(),
}

const chips = (text: string, caret: number | null = null) =>
  composerMarks(text, known, commands, caret).flatMap((mark) =>
    mark.kind === "chip" ? [text.slice(mark.from, mark.to)] : [],
  )

describe("composerMarks", () => {
  test("make every skill a chip, before punctuation and Japanese text too", () => {
    expect(chips("/kalan-mode move ドラマ\nthen /code-review。and /kalan-modeで")).toStrictEqual([
      "/kalan-mode",
      "/code-review",
      "/kalan-mode",
    ])
  })

  test("make the agent's own commands chips too, and leave code alone", () => {
    expect(chips("/compact then `/kalan-mode`\n```\n/kalan-mode\n```")).toStrictEqual(["/compact"])
    expect(composerMarks("/compact", known, commands, 8)).toStrictEqual([{ kind: "command", from: 0, to: 8 }])
  })

  test("wait while the caret is right after a name at the end of its line", () => {
    expect(chips("/kalan-mode", 11)).toStrictEqual([])
    expect(chips("/kalan-mode\nnext", 11)).toStrictEqual([])
    expect(chips("/kalan-mode ", 12)).toStrictEqual(["/kalan-mode"])
    expect(chips("/kalan-mode", 0)).toStrictEqual(["/kalan-mode"])
  })

  test("mark each line of a fenced block and the code to color", () => {
    const marks = composerMarks("run\n```ts\nconst a = 1\n```", known, commands, null)
    expect(marks).toStrictEqual([
      { kind: "fenceLine", from: 4, first: true, last: false },
      { kind: "marker", from: 4, to: 9 },
      { kind: "fenceLine", from: 10, first: false, last: false },
      { kind: "fenceLine", from: 22, first: false, last: true },
      { kind: "marker", from: 22, to: 25 },
      { kind: "fenceCode", from: 10, code: "const a = 1", language: "ts" },
    ])
  })

  test("bold the text between its muted markers, and show a bullet as a dot", () => {
    expect(composerMarks("- **hi**\n2. x", known, commands, null)).toStrictEqual([
      { kind: "listItem", from: 0, markerFrom: 0, to: 2, indentColumns: 0 },
      { kind: "dot", from: 0, to: 1 },
      { kind: "strong", from: 2, to: 8 },
      { kind: "marker", from: 2, to: 4 },
      { kind: "marker", from: 6, to: 8 },
      { kind: "listItem", from: 9, markerFrom: 9, to: 12, indentColumns: 0 },
    ])
  })

  test("measure a nested item's indent in columns, a tab as four", () => {
    expect(composerMarks("1. a\n   - b\n\t3. c", known, commands, null)).toStrictEqual([
      { kind: "listItem", from: 0, markerFrom: 0, to: 3, indentColumns: 0 },
      { kind: "listItem", from: 5, markerFrom: 8, to: 10, indentColumns: 3 },
      { kind: "dot", from: 8, to: 9 },
      { kind: "listItem", from: 12, markerFrom: 13, to: 16, indentColumns: 4 },
    ])
  })

  test("hide a quote's marker and mark its line", () => {
    expect(composerMarks("a\n> **b**\n>c", known, commands, null)).toStrictEqual([
      { kind: "quoteLine", from: 2 },
      { kind: "hidden", from: 2, to: 4 },
      { kind: "strong", from: 4, to: 9 },
      { kind: "marker", from: 4, to: 6 },
      { kind: "marker", from: 7, to: 9 },
    ])
  })

  test("draw a rule until the caret enters its line", () => {
    expect(composerMarks("a\n---", known, commands, 0)).toStrictEqual([{ kind: "rule", from: 2, to: 5 }])
    expect(composerMarks("a\n---", known, commands, 5)).toStrictEqual([{ kind: "marker", from: 2, to: 5 }])
  })
})
