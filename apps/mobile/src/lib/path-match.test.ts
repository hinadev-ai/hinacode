import { describe, expect, it } from "vitest"
import { lineSnippet, matchPaths } from "./path-match"

const order = (paths: string[], query: string) => matchPaths(paths, query).map((match) => match.path)

describe("matchPaths", () => {
  it("matches a case-insensitive subsequence and skips the rest", () => {
    expect(order(["src/Button.tsx", "src/index.ts", "README.md"], "btn")).toEqual(["src/Button.tsx"])
  })

  it("is empty for a blank query", () => {
    expect(matchPaths(["a.ts"], "  ")).toEqual([])
  })

  it("ranks a hit in the file name above one that needs the folders", () => {
    expect(order(["files/index.ts", "src/files.tsx"], "files")).toEqual(["src/files.tsx", "files/index.ts"])
  })

  it("ranks consecutive and earlier matches higher", () => {
    expect(order(["a/xtxhxexmxe.ts", "a/theme.ts"], "theme")).toEqual(["a/theme.ts", "a/xtxhxexmxe.ts"])
    expect(order(["a/use-theme.ts", "a/theme.ts"], "theme")).toEqual(["a/theme.ts", "a/use-theme.ts"])
  })

  it("prefers word starts when it places the query", () => {
    const [match] = matchPaths(["src/fileViewer.tsx"], "fv")
    expect(match.positions).toEqual([4, 8])
  })

  it("returns positions in the whole path, for emphasis", () => {
    const [inName] = matchPaths(["src/app/file.tsx"], "file")
    expect(inName.positions).toEqual([8, 9, 10, 11])
    const [inPath] = matchPaths(["src/app/x.ts"], "sax")
    expect(inPath.positions).toEqual([0, 4, 8])
  })

  it("ignores whitespace in the query", () => {
    expect(order(["src/app/file.tsx"], "app file")).toEqual(["src/app/file.tsx"])
  })

  it("returns at most 50 results", () => {
    const paths = Array.from({ length: 80 }, (_, index) => `src/file-${index}.ts`)
    expect(matchPaths(paths, "file")).toHaveLength(50)
  })
})

describe("lineSnippet", () => {
  it("keeps a short line whole without its indent and marks the match", () => {
    expect(lineSnippet("  return needle", "NEEDLE")).toEqual({ text: "return needle", match: { start: 7, end: 13 } })
  })

  it("starts a long line shortly before a late match, so the match stays in view", () => {
    const line = "export function handler7(input: string): number { return input.length * 7 } // needle-7"
    const snippet = lineSnippet(line, "needle-7", 10)
    expect(snippet.text).toBe("…* 7 } // needle-7")
    expect(snippet.text.slice(snippet.match?.start, snippet.match?.end)).toBe("needle-7")
  })

  it("has no match when the line does not contain the query", () => {
    expect(lineSnippet("abc", "x")).toEqual({ text: "abc", match: null })
  })
})
