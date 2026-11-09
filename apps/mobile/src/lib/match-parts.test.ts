import { expect, it } from "vitest"
import { matchParts } from "./match-parts"

const marked = (text: string, query: string) =>
  matchParts(text, query)
    .map((part) => (part.match ? `[${part.text}]` : part.text))
    .join("")

it("marks every case-insensitive occurrence of each word", () => {
  expect(marked("Add boat.dev, then Boat SDK", "boat")).toBe("Add [boat].dev, then [Boat] SDK")
  expect(marked("Price boat.dev vs a runner", "runner  boat")).toBe("Price [boat].dev vs a [runner]")
})

it("merges words that overlap or touch into one match", () => {
  expect(matchParts("boatdev", "boat oatd dev")).toStrictEqual([{ text: "boatdev", match: true, start: 0 }])
})

it("returns the text unmarked without a query or when lowercasing changes its length", () => {
  expect(matchParts("Add boat", "  ")).toStrictEqual([{ text: "Add boat", match: false, start: 0 }])
  expect(matchParts("İstanbul", "stan")).toStrictEqual([{ text: "İstanbul", match: false, start: 0 }])
  expect(matchParts("", "boat")).toStrictEqual([{ text: "", match: false, start: 0 }])
})
