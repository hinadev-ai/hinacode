import { describe, expect, test } from "@effect/vitest"
import { formatRelativeTime } from "./relativeTime.ts"

const now = Date.parse("2026-10-12T12:00:00.000Z")
const ago = (seconds: number) => new Date(now - seconds * 1000).toISOString()
const minute = 60
const hour = 60 * minute
const day = 24 * hour

describe("formatRelativeTime", () => {
  test.each([
    [0, "now"],
    [59, "now"],
    [-30, "now"],
    [minute, "1m ago"],
    [5 * minute, "5m ago"],
    [hour - 1, "59m ago"],
    [hour, "1h ago"],
    [3 * hour, "3h ago"],
    [day - 1, "23h ago"],
    [day, "1d ago"],
    [7 * day - 1, "6d ago"],
    [7 * day, "1w ago"],
    [21 * day, "3w ago"],
    [30 * day - 1, "4w ago"],
    [30 * day, "1mo ago"],
    [120 * day, "4mo ago"],
    [365 * day - 1, "12mo ago"],
    [365 * day, "1y ago"],
    [800 * day, "2y ago"],
  ])("%i seconds ago reads %s in English", (seconds, expected) => {
    expect(formatRelativeTime(ago(seconds), now, "en")).toBe(expected)
  })

  test("uses the locale's wording", () => {
    expect(formatRelativeTime(ago(5 * minute), now, "zh-TW")).toBe("5 分鐘前")
    expect(formatRelativeTime(ago(10), now, "zh-TW")).toBe("現在")
  })
})
