import { describe, expect, test } from "@effect/vitest"
import { formatBytes } from "./AttachmentView.tsx"

describe("formatBytes", () => {
  test("shows a file over a gigabyte in gigabytes", () => {
    expect(formatBytes(1.2 * 1024 ** 3)).toBe("1.2 GB")
  })

  test("keeps smaller files in megabytes", () => {
    expect(formatBytes(46 * 1024 ** 2)).toBe("46 MB")
  })
})
