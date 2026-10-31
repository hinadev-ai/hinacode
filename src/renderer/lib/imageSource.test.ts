import { describe, expect, test } from "@effect/vitest"
import { attachmentUrl, projectFileUrl } from "../../shared/channels.ts"
import { imageSource } from "./imageSource.ts"

const root = "/Volumes/work/worktrees/app-1a2b"
const inThread = { environment: null, baseUrl: null, root }

describe("imageSource", () => {
  test("serves an absolute path inside the thread's folder from the project files", () => {
    expect(imageSource(`${root}/.context/shots/before%20fix.png`, inThread)).toBe(
      projectFileUrl(root, ".context/shots/before fix.png"),
    )
  })

  test("resolves a relative path against the thread's folder", () => {
    expect(imageSource("./.context/before.png", inThread)).toBe(projectFileUrl(root, ".context/before.png"))
  })

  test("serves any other absolute path as an attachment", () => {
    const saved = "/Users/me/Library/Application Support/kkcode/attachments/t/vm.png"
    expect(imageSource(encodeURI(saved), inThread)).toBe(attachmentUrl(saved, null))
    expect(imageSource(`${root}-other/a.png`, inThread)).toBe(attachmentUrl(`${root}-other/a.png`, null))
  })
})
