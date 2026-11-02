import { expect, test } from "@effect/vitest"
import { lineCounts } from "./patch.ts"

test("counts added and removed lines across files, skipping the file headers", () => {
  const patch = [
    "diff --git a/a.ts b/a.ts",
    "--- a/a.ts",
    "+++ b/a.ts",
    "@@ -1,2 +1,2 @@",
    "-old",
    "+new",
    "+++counter",
    " same",
    "diff --git a/b.ts b/b.ts",
    "--- /dev/null",
    "+++ b/b.ts",
    "+one",
  ].join("\n")
  expect(lineCounts(patch)).toStrictEqual({ added: 3, removed: 1 })
})
