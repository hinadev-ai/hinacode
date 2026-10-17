import { describe, expect, it } from "vitest"
import { codeLines } from "./code-lines"
import type { SyntaxSpan } from "./highlight"

describe("codeLines", () => {
  it("returns plain lines without spans", () => {
    expect(codeLines("a\n\nb", null)).toEqual([
      [{ type: "plain", text: "a" }],
      [],
      [{ type: "plain", text: "b" }],
    ])
  })

  it("gives an empty file one empty line and drops the line after a final break", () => {
    expect(codeLines("", null)).toEqual([[]])
    expect(codeLines("a\n", null)).toEqual([[{ type: "plain", text: "a" }]])
    expect(codeLines("\n", null)).toEqual([[]])
  })

  it("splits a span that crosses line breaks", () => {
    const source = "x /* a\nb */ y"
    const spans: SyntaxSpan[] = [
      { type: "plain", start: 0, end: 2 },
      { type: "comment", start: 2, end: 11 },
      { type: "plain", start: 11, end: 13 },
    ]
    expect(codeLines(source, spans)).toEqual([
      [
        { type: "plain", text: "x " },
        { type: "comment", text: "/* a" },
      ],
      [
        { type: "comment", text: "b */" },
        { type: "plain", text: " y" },
      ],
    ])
  })

  it("strips the carriage return of \\r\\n, even when it is a span of its own", () => {
    const source = "let a\r\nb\r\n"
    const spans: SyntaxSpan[] = [
      { type: "keyword", start: 0, end: 3 },
      { type: "plain", start: 3, end: 5 },
      { type: "plain", start: 5, end: 6 },
      { type: "plain", start: 6, end: 10 },
    ]
    expect(codeLines(source, spans)).toEqual([
      [
        { type: "keyword", text: "let" },
        { type: "plain", text: " a" },
      ],
      [{ type: "plain", text: "b" }],
    ])
  })

  it("leaves text after the last span plain, for a highlighted prefix", () => {
    const spans: SyntaxSpan[] = [{ type: "string", start: 0, end: 3 }]
    expect(codeLines('"a"\nrest', spans)).toEqual([
      [{ type: "string", text: '"a"' }],
      [{ type: "plain", text: "rest" }],
    ])
  })

  it("fills gaps between spans with plain text and ignores spans past the end", () => {
    const spans: SyntaxSpan[] = [
      { type: "number", start: 2, end: 3 },
      { type: "number", start: 9, end: 12 },
    ]
    expect(codeLines("a 1 b", spans)).toEqual([
      [
        { type: "plain", text: "a " },
        { type: "number", text: "1" },
        { type: "plain", text: " b" },
      ],
    ])
  })
})
