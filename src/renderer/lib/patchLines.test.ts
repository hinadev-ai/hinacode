import { expect, test } from "vitest"
import { patchLines } from "./patchLines.ts"

const PATCH = `diff --git a/a.txt b/a.txt
--- a/a.txt
+++ b/a.txt
@@ -1,3 +1,4 @@
 one
-two
+2
 three
+four
@@ -10,2 +11,2 @@
 ten
-eleven
+ELEVEN
\\ No newline at end of file`

test("reads the new side's lines, skipping removed ones", () => {
  expect(patchLines(PATCH, "RIGHT", 1, 4)).toBe("one\n2\nthree\nfour")
})

test("reads the old side's lines, skipping added ones", () => {
  expect(patchLines(PATCH, "LEFT", 2, 3)).toBe("two\nthree")
})

test("finds lines in a later hunk and ignores the no newline marker", () => {
  expect(patchLines(PATCH, "RIGHT", 12, 12)).toBe("ELEVEN")
  expect(patchLines(PATCH, "LEFT", 11, 11)).toBe("eleven")
})
