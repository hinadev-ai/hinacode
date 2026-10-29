import { describe, expect, test } from "@effect/vitest"
import { toPlanLimits } from "./limits.ts"

const observed = {
  observedAtMs: 1791877430725,
  tier: "27681631238169137",
  weekly: { resetsAtMs: 1792368000000, usedPercent: 0 },
  window: { resetsAtMs: 1791894849000, usedPercent: 1, windowDurationMins: 300 },
}

describe("toPlanLimits", () => {
  test("reads a five-hour window as the session and the weekly window, with ISO times", () => {
    expect(toPlanLimits(observed)).toStrictEqual({
      windows: [
        { window: { kind: "session" }, usedPercent: 1, resetsAt: "2026-10-13T12:34:09.000Z" },
        { window: { kind: "weekly" }, usedPercent: 0, resetsAt: "2026-10-19T00:00:00.000Z" },
      ],
      readAt: "2026-10-13T07:43:50.725Z",
    })
  })

  test("names a window of another length by its minutes", () => {
    const hourly = { ...observed, window: { ...observed.window, windowDurationMins: 60 } }
    expect(toPlanLimits(hourly).windows[0]?.window).toStrictEqual({ kind: "minutes", minutes: 60 })
  })
})
