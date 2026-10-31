import { describe, expect, test } from "@effect/vitest"
import type { LimitWindow } from "./limits.ts"
import { formatResetIn, msUntilNextReset, spentWindow } from "./planLimits.ts"

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

describe("spentWindow", () => {
  const session: LimitWindow = { window: { kind: "session" }, usedPercent: 100, resetsAt: inSeconds(2 * hour) }
  const weekly: LimitWindow = { window: { kind: "weekly" }, usedPercent: 100, resetsAt: inSeconds(3 * day) }
  const fable: LimitWindow = { window: { kind: "model", name: "Fable" }, usedPercent: 100, resetsAt: inSeconds(day) }
  const roomy: LimitWindow = { ...weekly, usedPercent: 99.5 }

  test("is undefined while every window has room", () => {
    expect(spentWindow([{ ...session, usedPercent: 80 }, roomy], "claude-sonnet-5-5")).toBeUndefined()
  })

  test("is the spent window that resets last", () => {
    expect(spentWindow([session, roomy], "claude-sonnet-5-5")).toBe(session)
    expect(spentWindow([session, weekly], "claude-sonnet-5-5")).toBe(weekly)
    expect(spentWindow([{ ...session, resetsAt: null }, weekly], "claude-sonnet-5-5")?.resetsAt).toBeNull()
  })

  test("counts a model's window only for that model", () => {
    expect(spentWindow([fable], "claude-fable-5-1")).toBe(fable)
    expect(spentWindow([fable], "claude-sonnet-5-5")).toBeUndefined()
  })
})

const resetIn = (seconds: number | null): LimitWindow => ({
  window: { kind: "session" },
  usedPercent: 40,
  resetsAt: seconds === null ? null : inSeconds(seconds),
})
const limits = (...windows: ReadonlyArray<LimitWindow>) => ({ windows, readAt: inSeconds(0) })

describe("msUntilNextReset", () => {
  test("is the time until the soonest window of any account resets", () => {
    expect(
      msUntilNextReset(
        [
          { provider: "claude", accountId: null, limits: limits(resetIn(3 * day), resetIn(2 * hour)) },
          { provider: "codex", accountId: null, limits: limits(resetIn(hour)) },
        ],
        now,
      ),
    ).toBe(hour * 1000)
  })

  test("skips windows that already reset or never do, and accounts without limits", () => {
    expect(
      msUntilNextReset(
        [
          { provider: "claude", accountId: null, limits: limits(resetIn(-minute), resetIn(null)) },
          { provider: "codex", accountId: null, limits: null },
        ],
        now,
      ),
    ).toBeUndefined()
  })
})
