import { describe, expect, test } from "vitest"
import { fileIconName, fileIconSvg } from "./fileIcons.ts"

describe("fileIconName", () => {
  test.each([
    ["src/app.ts", "typescript"],
    ["src/main.py", "python"],
    ["docs/guide.md", "markdown"],
    ["release.tar.gz", "zip"],
    ["notes.unknownext", "_file"],
  ])("%s uses the %s icon", (path, icon) => {
    expect(fileIconName(path)).toBe(icon)
  })

  test("a file name wins over its extension", () => {
    expect(fileIconName("apps/web/package.json")).not.toBe(fileIconName("data.json"))
  })

  test("the longest extension wins", () => {
    expect(fileIconName("src/env.d.ts")).not.toBe("typescript")
  })

  test("names compare in lowercase", () => {
    expect(fileIconName("Dockerfile")).toBe(fileIconName("dockerfile"))
  })
})

describe("fileIconSvg", () => {
  test("returns markup colored by the theme variables", () => {
    expect(fileIconSvg("src/app.ts")).toContain("var(--vscode-ctp-")
  })
})
