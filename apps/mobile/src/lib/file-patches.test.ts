import { describe, expect, it } from "vitest"
import { filePatches } from "./file-patches"

const patch = [
  "diff --git a/src/a b.ts b/src/a b.ts",
  "index 1111111..2222222 100644",
  "--- a/src/a b.ts",
  "+++ b/src/a b.ts",
  "@@ -1,2 +1,3 @@",
  " keep",
  "-old",
  "+new",
  "+more",
  "diff --git a/docs/new.md b/docs/new.md",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/docs/new.md",
  "@@ -0,0 +1 @@",
  "+hello",
].join("\n")

describe("filePatches", () => {
  it("splits a diff per file, keyed by path, with spaces kept", () => {
    expect([...filePatches(patch).keys()]).toEqual(["src/a b.ts", "docs/new.md"])
  })

  it("counts only lines inside hunks", () => {
    const files = filePatches(patch)
    expect(files.get("src/a b.ts")).toMatchObject({ added: 2, removed: 1 })
    expect(files.get("docs/new.md")).toMatchObject({ added: 1, removed: 0 })
  })

  it("keeps each file's own lines", () => {
    expect(filePatches(patch).get("docs/new.md")?.patch.split("\n")).toEqual([
      "diff --git a/docs/new.md b/docs/new.md",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/docs/new.md",
      "@@ -0,0 +1 @@",
      "+hello",
    ])
  })

  it("has nothing for an empty diff", () => {
    expect(filePatches("").size).toBe(0)
  })
})
