import { describe, expect, test } from "vitest"
import { suggestProjectName } from "./projectName.ts"

describe("suggestProjectName", () => {
  test.each([
    ["/home/me/code/hinacode", "hinacode"],
    ["~/code/hinacode/ ", "hinacode"],
    ["C:\\Users\\me\\code\\hinacode", "hinacode"],
    ["kjj6198/hinacode", "hinacode"],
    ["https://github.com/kjj6198/hinacode.git", "hinacode"],
    ["", ""],
  ])("names %j %j", (source, name) => {
    expect(suggestProjectName(source)).toBe(name)
  })
})
