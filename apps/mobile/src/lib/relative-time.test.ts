import { expect, it } from "vitest"
import { relativeTime } from "./relative-time"

const NOW = Date.parse("2026-10-18T12:00:00.000Z")
const ago = (ms: number) => new Date(NOW - ms).toISOString()

it("counts minutes, hours and days", () => {
  expect(relativeTime(ago(30_000), NOW)).toBe("now")
  expect(relativeTime(ago(5 * 60_000), NOW)).toBe("5m")
  expect(relativeTime(ago(3 * 3_600_000 + 59 * 60_000), NOW)).toBe("3h")
  expect(relativeTime(ago(2 * 86_400_000), NOW)).toBe("2d")
})

it("treats a time slightly in the future as now", () => {
  expect(relativeTime(ago(-5_000), NOW)).toBe("now")
})

it("shows a short date after a week", () => {
  const iso = ago(10 * 86_400_000)
  expect(relativeTime(iso, NOW)).toBe(new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" }))
})

it("adds the year to a date from another year", () => {
  expect(relativeTime("2025-03-01T12:00:00.000Z", NOW)).toContain("2025")
})
