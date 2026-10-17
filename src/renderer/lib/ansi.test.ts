import { describe, expect, test } from "@effect/vitest"
import { ansiSegments } from "./ansi.ts"

describe("ansiSegments", () => {
  test("keeps plain text as one unstyled run", () => {
    expect(ansiSegments("hello\nworld")).toEqual([{ text: "hello\nworld", style: {} }])
  })

  test("maps named colors to the terminal palette and keeps text styles", () => {
    expect(ansiSegments("\x1b[1mUsage:\x1b[0m skills \x1b[31merr\x1b[0m \x1b[92mok\x1b[39m")).toEqual([
      { text: "Usage:", style: { fontWeight: "bold" } },
      { text: " skills ", style: {} },
      { text: "err", style: { color: "var(--term-color-1)" } },
      { text: " ", style: {} },
      { text: "ok", style: { color: "var(--term-color-10)" } },
    ])
  })

  test("passes truecolor through", () => {
    expect(ansiSegments("\x1b[38;2;10;20;30mx")).toEqual([{ text: "x", style: { color: "rgb(10, 20, 30)" } }])
  })

  test("drops cursor and screen control codes", () => {
    const text = ansiSegments("\x1b[?25l│\n\x1b[1G\x1b[J◇ done\x1b[?25h")
    expect(text.map((segment) => segment.text).join("")).toBe("│\n◇ done")
  })
})
