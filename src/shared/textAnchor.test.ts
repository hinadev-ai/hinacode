import { expect, test } from "vitest"
import { resolveTextAnchor, textAnchorAt } from "./textAnchor.ts"

test("quotes the selection with up to 32 characters of context on each side", () => {
  const text = `${"a".repeat(40)}QUOTE${"b".repeat(40)}`

  expect(textAnchorAt(text, 40, 45)).toEqual({
    kind: "text",
    quote: "QUOTE",
    prefix: "a".repeat(32),
    suffix: "b".repeat(32),
  })
})

test("takes the context that exists at the edges of the text", () => {
  expect(textAnchorAt("Ship it now", 0, 4)).toEqual({ kind: "text", quote: "Ship", prefix: "", suffix: " it now" })
  expect(textAnchorAt("Ship it now", 8, 11)).toEqual({ kind: "text", quote: "now", prefix: "Ship it ", suffix: "" })
})

test("finds a quote that moved", () => {
  const anchor = textAnchorAt("The migration runs before the deploy.", 4, 18)

  expect(resolveTextAnchor("Intro.\nThe migration runs before the deploy.", anchor)).toEqual({ from: 11, to: 25 })
})

test("picks the occurrence whose surrounding text matches the anchor's context", () => {
  const text = "Run the tests. Then run the tests again."
  const second = textAnchorAt(text, 24, 33)

  expect(resolveTextAnchor(text, second)).toEqual({ from: 24, to: 33 })
  expect(resolveTextAnchor(text, textAnchorAt(text, 4, 13))).toEqual({ from: 4, to: 13 })
})

test("keeps preferring the right occurrence after its context was partly edited", () => {
  const anchor = textAnchorAt("First, the tests. Later, the tests again.", 29, 34)

  expect(resolveTextAnchor("First, the tests. Much later, the tests again.", anchor)).toEqual({ from: 34, to: 39 })
})

test("takes the first occurrence of a quote without context", () => {
  expect(resolveTextAnchor("a b a b", { kind: "text", quote: "b", prefix: "", suffix: "" })).toEqual({
    from: 2,
    to: 3,
  })
})

test("finds a quote an agent copied from the Markdown, with its inline syntax", () => {
  const text = "Ship the editor first. Read the guide, then run pnpm build and snake_case stays."
  const quoted = (quote: string) => {
    const found = resolveTextAnchor(text, { kind: "text", quote, prefix: "", suffix: "" })
    return found === null ? null : text.slice(found.from, found.to)
  }

  expect(quoted("Ship the **editor** first.")).toBe("Ship the editor first.")
  expect(quoted("Ship the _editor_ ~~first~~.")).toBe("Ship the editor first.")
  expect(quoted("Read the [guide](https://example.com/guide), then run `pnpm build`")).toBe(
    "Read the guide, then run pnpm build",
  )
  expect(quoted("snake_case stays.")).toBe("snake_case stays.")
  expect(quoted("Ship the **toolbar** first.")).toBe(null)
})

test("is null when the quote is gone", () => {
  const anchor = textAnchorAt("Ship the editor first.", 9, 15)

  expect(resolveTextAnchor("Ship the toolbar first.", anchor)).toBe(null)
})
