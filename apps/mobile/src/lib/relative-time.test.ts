import { expect, it } from "vitest"
import { relativeTime } from "./relative-time"

const NOW = Date.parse("2026-10-18T12:00:00.000Z")
const ago = (ms: number) => new Date(NOW - ms).toISOString()
const DAY = 86_400_000

it("counts in the largest whole unit, like the desktop", () => {
  expect(relativeTime(ago(30_000), NOW)).toBe("now")
  expect(relativeTime(ago(5 * 60_000), NOW)).toBe("5m ago")
  expect(relativeTime(ago(3 * 3_600_000 + 59 * 60_000), NOW)).toBe("3h ago")
  expect(relativeTime(ago(2 * DAY), NOW)).toBe("2d ago")
  expect(relativeTime(ago(15 * DAY), NOW)).toBe("2w ago")
  expect(relativeTime(ago(65 * DAY), NOW)).toBe("2mo ago")
  expect(relativeTime(ago(800 * DAY), NOW)).toBe("2y ago")
})

it("treats a time slightly in the future as now", () => {
  expect(relativeTime(ago(-5_000), NOW)).toBe("now")
})
