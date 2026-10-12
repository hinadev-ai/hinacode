import { describe, expect, test } from "@effect/vitest"
import type { FsEntry } from "../../shared/domain.ts"
import { flattenTree, parentOf } from "./explorer.ts"

const dir = (path: string): FsEntry => ({
  name: path.slice(path.lastIndexOf("/") + 1),
  path,
  kind: "dir",
  ignored: false,
  gitStatus: null,
})
const file = (path: string): FsEntry => ({ ...dir(path), kind: "file" })

const children = {
  "": [dir("src"), dir("docs"), file("README.md")],
  src: [dir("src/main"), file("src/index.ts")],
  "src/main": [file("src/main/app.ts")],
  docs: [file("docs/arch.md")],
}

const visible = (expanded: ReadonlyArray<string>) =>
  flattenTree({ expanded: new Set(expanded), children }).map(({ entry, depth }) => [entry.path, depth])

describe("flattenTree", () => {
  test("shows only the root's entries when nothing is expanded", () => {
    expect(visible([])).toStrictEqual([
      ["src", 0],
      ["docs", 0],
      ["README.md", 0],
    ])
  })

  test("nests expanded folders under their parent, one level deeper each", () => {
    expect(visible(["src", "src/main"])).toStrictEqual([
      ["src", 0],
      ["src/main", 1],
      ["src/main/app.ts", 2],
      ["src/index.ts", 1],
      ["docs", 0],
      ["README.md", 0],
    ])
  })

  test("hides an expanded folder's entries while an ancestor is collapsed", () => {
    expect(visible(["src/main", "docs"])).toStrictEqual([
      ["src", 0],
      ["docs", 0],
      ["docs/arch.md", 1],
      ["README.md", 0],
    ])
  })

  test("shows an expanded folder that is not listed yet as empty", () => {
    expect(flattenTree({ expanded: new Set(["src"]), children: { "": children[""] } })).toHaveLength(3)
  })

  test("numbers each row among its siblings", () => {
    const rows = flattenTree({ expanded: new Set(["src"]), children })
    expect(rows.map(({ setSize, posInSet }) => [setSize, posInSet])).toStrictEqual([
      [3, 1],
      [2, 1],
      [2, 2],
      [3, 2],
      [3, 3],
    ])
  })
})

describe("parentOf", () => {
  test("is the folder above, or the root", () => {
    expect(parentOf("src/main/app.ts")).toBe("src/main")
    expect(parentOf("README.md")).toBe("")
  })
})
