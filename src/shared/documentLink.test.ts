import { expect, test } from "vitest"
import { linkHref } from "./documentLink.ts"

test("keeps web and mail links and completes a bare host", () => {
  expect(linkHref("https://hinacode.dev/docs")).toBe("https://hinacode.dev/docs")
  expect(linkHref("  http://localhost:3000 ")).toBe("http://localhost:3000")
  expect(linkHref("mailto:dev@example.com")).toBe("mailto:dev@example.com")
  expect(linkHref("github.com/hinadev-ai/hinacode")).toBe("https://github.com/hinadev-ai/hinacode")
})

test("refuses anything that is not a web or mail link", () => {
  for (const text of [
    "",
    "   ",
    "javascript:alert(1)",
    "JavaScript:alert(1)",
    "file:///etc/passwd",
    "data:text/html,x",
    "not a url",
  ])
    expect(linkHref(text), text).toBeNull()
})
