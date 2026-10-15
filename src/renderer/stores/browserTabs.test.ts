import { describe, expect, test } from "@effect/vitest"
import { type BrowserTabs, closeTab, NO_TABS, openTab } from "./browserTabs.ts"

const tab = (id: string) => ({ id, url: `http://localhost:3000/${id}`, title: id })
const tabs = (ids: ReadonlyArray<string>, activeId: string): BrowserTabs => ({ tabs: ids.map(tab), activeId })
const ids = (state: BrowserTabs) => state.tabs.map((each) => each.id)

describe("openTab", () => {
  test("appends an empty tab and shows it", () => {
    const next = openTab(tabs(["a", "b"], "a"))
    const opened = next.tabs.at(-1)!
    expect(ids(next).slice(0, 2)).toStrictEqual(["a", "b"])
    expect(opened).toMatchObject({ url: null, title: null })
    expect(next.activeId).toBe(opened.id)
  })
})

describe("closeTab", () => {
  test("shows the tab to the right when the shown tab closes", () => {
    expect(closeTab(tabs(["a", "b", "c"], "b"), "b")).toStrictEqual(tabs(["a", "c"], "c"))
  })

  test("shows the tab to the left when the last tab in the row closes", () => {
    expect(closeTab(tabs(["a", "b", "c"], "c"), "c")).toStrictEqual(tabs(["a", "b"], "b"))
  })

  test("keeps the shown tab when a hidden one closes", () => {
    expect(closeTab(tabs(["a", "b", "c"], "a"), "c")).toStrictEqual(tabs(["a", "b"], "a"))
  })

  test("replaces the only tab with a new empty one", () => {
    const next = closeTab(tabs(["a"], "a"), "a")
    expect(next.tabs).toHaveLength(1)
    expect(next.tabs[0]).toMatchObject({ url: null, title: null })
    expect(next.activeId).toBe(next.tabs[0]!.id)
    expect(next.activeId).not.toBe("a")
    expect(next.activeId).not.toBe(NO_TABS.activeId)
  })
})
