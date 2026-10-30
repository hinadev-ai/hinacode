import { describe, expect, test } from "@effect/vitest"
import { cycleSwitcher, visitRecent } from "./threadSwitcher.ts"

describe("visitRecent", () => {
  test("moves a revisited thread to the front without duplicating it", () => {
    expect(visitRecent(["a", "b", "c"], "c")).toStrictEqual(["c", "a", "b"])
  })

  test("forgets the oldest thread past ten", () => {
    const recent = Array.from({ length: 10 }, (_, index) => `t${index}`)
    expect(visitRecent(recent, "new")).toStrictEqual(["new", ...recent.slice(0, 9)])
  })
})

describe("cycleSwitcher", () => {
  test("opens on the previous thread, and backwards on the oldest", () => {
    expect(cycleSwitcher(null, ["a", "b", "c"], "a", 1)).toStrictEqual({ threadIds: ["a", "b", "c"], index: 1 })
    expect(cycleSwitcher(null, ["a", "b", "c"], "a", -1)).toStrictEqual({ threadIds: ["a", "b", "c"], index: 2 })
  })

  test("from outside a thread, opens on the latest thread", () => {
    expect(cycleSwitcher(null, ["a", "b"], null, 1)?.index).toBe(0)
  })

  test("wraps around while open", () => {
    const open = { threadIds: ["a", "b", "c"], index: 2 }
    expect(cycleSwitcher(open, ["z"], "a", 1)?.index).toBe(0)
    expect(cycleSwitcher({ ...open, index: 0 }, ["z"], "a", -1)?.index).toBe(2)
  })

  test("stays closed with no other thread to switch to", () => {
    expect(cycleSwitcher(null, [], null, 1)).toBeNull()
    expect(cycleSwitcher(null, ["a"], "a", 1)).toBeNull()
  })
})
