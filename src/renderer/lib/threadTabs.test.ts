import { describe, expect, test } from "@effect/vitest"
import { navigateTabs, neighborTab, openTab } from "./threadTabs.ts"

describe("navigateTabs", () => {
  test("a thread with a tab keeps the tabs as they are", () => {
    const tabs = ["a", "b"]
    expect(navigateTabs(tabs, ["a", "b"], "b")).toBe(tabs)
  })

  test("a thread without a tab takes over the tab the user was last in", () => {
    expect(navigateTabs(["a", "b", "c"], ["b", "x", "a"], "d")).toStrictEqual(["a", "d", "c"])
  })

  test("skips recent threads whose tab was closed", () => {
    expect(navigateTabs(["a", "c"], ["b", "c", "a"], "d")).toStrictEqual(["a", "d"])
  })

  test("the first thread gets a new tab", () => {
    expect(navigateTabs([], [], "a")).toStrictEqual(["a"])
  })
})

describe("openTab", () => {
  test("opens at the end, so tabs keep the order they were opened in", () => {
    expect(openTab(["a", "b"], "c", "a")).toStrictEqual(["a", "b", "c"])
    expect(openTab(["a", "b", "c"], "d", "a")).toStrictEqual(["a", "b", "c", "d"])
  })

  test("keeps an existing tab where it is", () => {
    const tabs = ["a", "b"]
    expect(openTab(tabs, "b", "a")).toBe(tabs)
  })

  test("adds the open thread's tab when it has none, so it stays open too", () => {
    expect(openTab([], "b", "a")).toStrictEqual(["a", "b"])
  })

  test("outside a thread, only opens the new tab", () => {
    expect(openTab(["a"], "b", null)).toStrictEqual(["a", "b"])
  })
})

describe("neighborTab", () => {
  test("prefers the tab to the right, then the left", () => {
    expect(neighborTab(["a", "b", "c"], "b")).toBe("c")
    expect(neighborTab(["a", "b", "c"], "c")).toBe("b")
    expect(neighborTab(["a"], "a")).toBeUndefined()
  })
})
