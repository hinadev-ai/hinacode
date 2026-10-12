import { describe, expect, test } from "@effect/vitest"
import { formatResetIn } from "./planLimits.ts"

const now = Date.parse("2026-10-12T12:00:00.000Z")
const inSeconds = (seconds: number) => new Date(now + seconds * 1000).toISOString()
const minute = 60
const hour = 60 * minute
const day = 24 * hour

describe("formatResetIn", () => {
  test.each([
    [-30, "0m"],
    [59, "0m"],
    [45 * minute, "45m"],
    [hour - 1, "59m"],
    [hour, "1h 0m"],
    [3 * hour + 12 * minute + 30, "3h 12m"],
    [day - 1, "23h 59m"],
    [day, "1d 0h"],
    [2 * day + 6 * hour + 59 * minute, "2d 6h"],
  ])("%is ahead reads %s", (seconds, expected) => {
    expect(formatResetIn(inSeconds(seconds), now, "en")).toBe(expected)
  })

  test("uses the locale's units", () => {
    expect(formatResetIn(inSeconds(2 * day + 6 * hour), now, "zh-TW")).toBe("2 天 6 小時")
  })
})
