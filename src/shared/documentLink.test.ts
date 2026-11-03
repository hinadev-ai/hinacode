import { expect, test } from "vitest"
import { linkHref } from "./documentLink.ts"

test("keeps web links and completes a bare host, with or without a port", () => {
  expect(linkHref("https://hinacode.dev/docs")).toBe("https://hinacode.dev/docs")
  expect(linkHref("  http://localhost:3000 ")).toBe("http://localhost:3000")
  expect(linkHref("github.com/hinadev-ai/hinacode")).toBe("https://github.com/hinadev-ai/hinacode")
  expect(linkHref("localhost:3000/settings")).toBe("https://localhost:3000/settings")
  expect(linkHref("example.com:8080/x")).toBe("https://example.com:8080/x")
})

test("refuses anything the app would not open in the browser", () => {
  for (const text of [
    "",
    "   ",
    "javascript:alert(1)",
    "JavaScript:alert(1)",
    "file:///etc/passwd",
    "data:text/html,x",
    "mailto:dev@example.com",
    "not a url",
  ])
    expect(linkHref(text), text).toBeNull()
})
