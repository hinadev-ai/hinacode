import { describe, expect, test } from "@effect/vitest"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import type { Attachment } from "../../shared/domain.ts"
import { FileChip, formatBytes } from "./AttachmentView.tsx"

describe("formatBytes", () => {
  test("shows a file over a gigabyte in gigabytes", () => {
    expect(formatBytes(1.2 * 1024 ** 3)).toBe("1.2 GB")
  })

  test("keeps smaller files in megabytes", () => {
    expect(formatBytes(46 * 1024 ** 2)).toBe("46 MB")
  })
})

describe("FileChip", () => {
  const attachment: Attachment = {
    id: "a",
    name: "stripe-409.png",
    path: "/tmp/attachments/missing.png",
    mime: "image/png",
    kind: "image",
    bytes: 46 * 1024 ** 2,
  }

  test("says the file is gone instead of its size", () => {
    const html = renderToStaticMarkup(createElement(FileChip, { attachment, gone: true }))
    expect(html).toContain("stripe-409.png")
    expect(html).toContain("File is gone")
    expect(html).not.toContain("46 MB")
  })
})
