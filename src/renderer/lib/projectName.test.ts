import { describe, expect, test } from "vitest"
import { suggestProjectName } from "./projectName.ts"

describe("suggestProjectName", () => {
  test.each([
    ["/home/me/code/hinacode", "hinacode"],
    ["~/code/hinacode/ ", "hinacode"],
    ["C:\\Users\\me\\code\\hinacode", "hinacode"],
    ["acme/web", "web"],
    ["https://github.com/acme/web.git", "web"],
    ["", ""],
  ])("names %j %j", (source, name) => {
    expect(suggestProjectName(source)).toBe(name)
  })
})
