import { describe, expect, it } from "vitest"
import { patchLines } from "./patch-lines"

const patch = [
  "diff --git a/src/a.ts b/src/a.ts",
  "index 1111111..2222222 100644",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -10,3 +10,3 @@ export function a() {",
  " keep",
  "-old",
  "+new",
  " keep",
  "@@ -40,2 +40,3 @@",
  " tail",
  "+added",
  " end",
  "\\ No newline at end of file",
].join("\n")

describe("patchLines", () => {
  it("drops the file headers and numbers each side across hunks", () => {
    expect(patchLines(patch)).toEqual([
      { kind: "hunk", text: "@@ -10,3 +10,3 @@ export function a() {", oldLine: null, newLine: null },
      { kind: "context", text: "keep", oldLine: 10, newLine: 10 },
      { kind: "deletion", text: "old", oldLine: 11, newLine: null },
      { kind: "addition", text: "new", oldLine: null, newLine: 11 },
      { kind: "context", text: "keep", oldLine: 12, newLine: 12 },
      { kind: "hunk", text: "@@ -40,2 +40,3 @@", oldLine: null, newLine: null },
      { kind: "context", text: "tail", oldLine: 40, newLine: 40 },
      { kind: "addition", text: "added", oldLine: null, newLine: 41 },
      { kind: "context", text: "end", oldLine: 41, newLine: 42 },
      { kind: "note", text: "\\ No newline at end of file", oldLine: null, newLine: null },
    ])
  })

  it("has no lines for a patch without hunks, like a binary file or a pure rename", () => {
    expect(patchLines("diff --git a/x.png b/x.png\nBinary files a/x.png and b/x.png differ")).toEqual([])
  })
})
