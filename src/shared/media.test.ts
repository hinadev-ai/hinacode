import { describe, expect, test } from "vitest"
import { extensionOf, mimeOf, previewMimeOf } from "./media.ts"

describe("extensionOf", () => {
  test("reads the lowercased extension of a file name or path", () => {
    expect(extensionOf("photo.PNG")).toBe("png")
    expect(extensionOf("docs/v1.2/notes.md")).toBe("md")
  })

  test("is empty for a name without a dot", () => {
    expect(extensionOf("Makefile")).toBe("")
    expect(extensionOf("docs/v1.2/LICENSE")).toBe("")
  })
})

describe("mimeOf", () => {
  test("does not take a bare name for its extension", () => {
    expect(previewMimeOf("png")).toBeUndefined()
    expect(mimeOf("assets/svg")).toBe("application/octet-stream")
  })
})
