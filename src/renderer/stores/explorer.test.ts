import { describe, expect, test } from "@effect/vitest"
import type { FsEntry } from "../../shared/domain.ts"
import {
  afterDelete,
  afterRename,
  emptyTree,
  type ExplorerTree,
  flattenTree,
  type Naming,
  parentOf,
  type TreeRow,
} from "./explorer.ts"

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

const label = (row: TreeRow) => (row.kind === "entry" ? row.entry.path : `new ${row.entryKind} in "${row.parent}"`)

const visible = (expanded: ReadonlyArray<string>, naming: Naming | null = null) =>
  flattenTree({ expanded: new Set(expanded), children, naming }).map((row) => [label(row), row.depth])

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
    expect(flattenTree({ expanded: new Set(["src"]), children: { "": children[""] }, naming: null })).toHaveLength(3)
  })

  test("numbers each row among its siblings", () => {
    const rows = flattenTree({ expanded: new Set(["src"]), children, naming: null })
    expect(rows.map((row) => (row.kind === "entry" ? [row.setSize, row.posInSet] : null))).toStrictEqual([
      [3, 1],
      [2, 1],
      [2, 2],
      [3, 2],
      [3, 3],
    ])
  })

  test("puts the name field for a new entry first in its folder, one level below it", () => {
    expect(visible(["src"], { kind: "create", parent: "src", entryKind: "file" })).toStrictEqual([
      ["src", 0],
      ['new file in "src"', 1],
      ["src/main", 1],
      ["src/index.ts", 1],
      ["docs", 0],
      ["README.md", 0],
    ])
    expect(visible([], { kind: "create", parent: "", entryKind: "dir" })[0]).toStrictEqual(['new dir in ""', 0])
  })

  test("keeps a renamed entry's row in place", () => {
    expect(visible([], { kind: "rename", path: "docs" })).toStrictEqual(visible([]))
  })
})

describe("parentOf", () => {
  test("is the folder above, or the root", () => {
    expect(parentOf("src/main/app.ts")).toBe("src/main")
    expect(parentOf("README.md")).toBe("")
  })
})

const opened: ExplorerTree = {
  ...emptyTree,
  expanded: new Set(["src", "src/main", "srcs"]),
  children,
  selected: "src/main/app.ts",
  opened: "src/main/app.ts",
  unsaved: { "src/main/app.ts": "base", "README.md": "base" },
  naming: { kind: "rename", path: "src" },
}

describe("afterRename", () => {
  test("moves the folder's expanded, selected and opened paths to the new name", () => {
    const tree = afterRename(opened, "src", "lib")
    expect([...tree.expanded]).toStrictEqual(["lib", "lib/main", "srcs"])
    expect(tree.selected).toBe("lib/main/app.ts")
    expect(tree.opened).toBe("lib/main/app.ts")
    expect(tree.naming).toBeNull()
  })

  test("drops the listings and unsaved edits under the old name", () => {
    const tree = afterRename(opened, "src", "lib")
    expect(Object.keys(tree.children)).toStrictEqual(["", "docs"])
    expect(tree.unsaved).toStrictEqual({ "README.md": "base" })
  })
})

describe("afterDelete", () => {
  test("closes the deleted file and selects its folder", () => {
    const tree = afterDelete(opened, "src/main/app.ts")
    expect(tree.opened).toBeNull()
    expect(tree.selected).toBe("src/main")
    expect(tree.unsaved).toStrictEqual({ "README.md": "base" })
  })

  test("forgets everything under a deleted folder but not a sibling sharing its prefix", () => {
    const tree = afterDelete(opened, "src")
    expect([...tree.expanded]).toStrictEqual(["srcs"])
    expect(Object.keys(tree.children)).toStrictEqual(["", "docs"])
    expect(tree.selected).toBeNull()
  })

  test("keeps the selection outside the deleted entry", () => {
    expect(afterDelete({ ...opened, selected: "README.md" }, "docs").selected).toBe("README.md")
  })
})
