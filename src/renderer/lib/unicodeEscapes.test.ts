import { describe, expect, test } from "@effect/vitest"
import { decodeUnicodeEscapes } from "./unicodeEscapes.ts"

describe("decodeUnicodeEscapes", () => {
  test("shows Japanese in JSON that an MCP server escaped to ASCII", () => {
    expect(decodeUnicodeEscapes(String.raw`{"results":"\u9000\u52e4 \ud83c\udf63"}`)).toBe(`{"results":"退勤 🍣"}`)
  })

  test("decodes a prefix that no longer parses as JSON", () => {
    expect(decodeUnicodeEscapes(String.raw`{"results":"\u51fa\u52e4`)).toBe(`{"results":"出勤`)
  })

  test("keeps ASCII escapes and escaped backslashes", () => {
    const text = String.raw`{"quote":"\u0022","path":"C:\\u9000"}`
    expect(decodeUnicodeEscapes(text)).toBe(text)
  })

  test("leaves text that is not JSON alone", () => {
    const source = String.raw`const kanji = "\u9000"`
    expect(decodeUnicodeEscapes(source)).toBe(source)
  })
})
