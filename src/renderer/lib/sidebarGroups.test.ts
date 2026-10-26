import { describe, expect, test } from "@effect/vitest"
import type { SidebarGroups } from "../../shared/domain.ts"
import {
  arrangeRows,
  assignGroup,
  createGroup,
  deleteGroup,
  moveGroup,
  renameGroup,
  setGroupCollapsed,
} from "./sidebarGroups.ts"

const empty: SidebarGroups = { groups: [], groupOf: {} }
const work = { id: "work", name: "Work", collapsed: false }
const side = { id: "side", name: "Side", collapsed: false }
const two = createGroup(createGroup(empty, work, "acme/web"), side, "me/blog")

const row = (key: string) => ({ key })
const keys = (rows: ReadonlyArray<{ key: string }>) => rows.map((each) => each.key)

describe("sidebar groups", () => {
  test("a new group goes last and takes the project it was created from", () => {
    expect(two).toStrictEqual({ groups: [work, side], groupOf: { "acme/web": "work", "me/blog": "side" } })
  })

  test("a project is in one group at a time", () => {
    const moved = assignGroup(two, "acme/web", "side")
    expect(moved.groupOf).toStrictEqual({ "acme/web": "side", "me/blog": "side" })
    expect(assignGroup(moved, "acme/web", null).groupOf).toStrictEqual({ "me/blog": "side" })
  })

  test("rename and collapse touch only their group", () => {
    const changed = setGroupCollapsed(renameGroup(two, "side", "Hobby"), "work", true)
    expect(changed.groups).toStrictEqual([
      { ...work, collapsed: true },
      { ...side, name: "Hobby" },
    ])
  })

  test("moving a group swaps it with its neighbor and stops at either end", () => {
    expect(moveGroup(two, "side", -1).groups).toStrictEqual([side, work])
    expect(moveGroup(two, "work", -1)).toBe(two)
    expect(moveGroup(two, "side", 1)).toBe(two)
  })

  test("deleting a group sends its projects back to the ungrouped list", () => {
    expect(deleteGroup(two, "work")).toStrictEqual({ groups: [side], groupOf: { "me/blog": "side" } })
  })

  test("rows are filed under their groups in order, empty groups kept", () => {
    const state = createGroup(two, { id: "empty", name: "Empty", collapsed: false }, "gone/repo")
    const arranged = arrangeRows([row("me/blog"), row("loose"), row("acme/web")], state)
    expect(arranged.grouped.map(({ group, rows }) => [group.id, keys(rows)])).toStrictEqual([
      ["work", ["acme/web"]],
      ["side", ["me/blog"]],
      ["empty", []],
    ])
    expect(keys(arranged.ungrouped)).toStrictEqual(["loose"])
  })

  test("a row pointing at a missing group is ungrouped", () => {
    const arranged = arrangeRows([row("acme/web")], { groups: [], groupOf: { "acme/web": "deleted" } })
    expect(keys(arranged.ungrouped)).toStrictEqual(["acme/web"])
  })
})
