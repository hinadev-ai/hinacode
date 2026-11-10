import { describe, expect, test } from "@effect/vitest"
import {
  defaultScheduleDraft,
  describeCron,
  fromCron,
  nextRuns,
  type ScheduleDraft,
  toCron,
  weekAhead,
} from "./schedule.ts"

const draft = (patch: Partial<ScheduleDraft>): ScheduleDraft => ({ ...defaultScheduleDraft, ...patch })

describe("toCron", () => {
  test.each([
    [draft({ repeat: "none" }), null],
    [draft({ repeat: "hourly", minute: 15 }), "15 * * * *"],
    [draft({ repeat: "daily", hour: 9, minute: 30 }), "30 9 * * *"],
    [draft({ repeat: "weekdays", hour: 18, minute: 0 }), "0 18 * * 1-5"],
    [draft({ repeat: "weekly", hour: 8, minute: 5, days: [5, 1, 1] }), "5 8 * * 1,5"],
    [draft({ repeat: "custom", cron: "  */10 * * * *  " }), "*/10 * * * *"],
  ])("%o becomes %s", (input, cron) => {
    expect(toCron(input)).toBe(cron)
  })
})

describe("fromCron", () => {
  test("reads no schedule as none", () => {
    expect(fromCron(null).repeat).toBe("none")
  })

  test.each([
    ["15 * * * *", { repeat: "hourly", minute: 15 }],
    ["30 9 * * *", { repeat: "daily", hour: 9, minute: 30 }],
    ["0 18 * * 1-5", { repeat: "weekdays", hour: 18, minute: 0 }],
    ["5 8 * * 1,5", { repeat: "weekly", hour: 8, minute: 5, days: [1, 5] }],
  ])("recognizes %s as a preset", (cron, expected) => {
    expect(fromCron(cron)).toMatchObject(expected)
  })

  test.each(["*/10 * * * *", "0 9 1 * *", "0 9 * 1 *", "0 9-17 * * *", "0 9 * * 5,1", "0 0 9 * * *", "61 9 * * *"])(
    "keeps %s as a custom expression",
    (cron) => {
      expect(fromCron(cron)).toMatchObject({ repeat: "custom", cron })
    },
  )

  test.each(["15 * * * *", "30 9 * * *", "0 18 * * 1-5", "5 8 * * 0,3,6"])("round trips %s", (cron) => {
    expect(toCron(fromCron(cron))).toBe(cron)
  })
})

describe("describeCron", () => {
  test.each([
    ["15 * * * *", "Every hour at :15"],
    ["5 * * * *", "Every hour at :05"],
    ["30 9 * * *", "Every day at 9:30 AM"],
    ["0 18 * * 1-5", "Weekdays at 6:00 PM"],
    ["0 8 * * 1,3", "Mon, Wed at 8:00 AM"],
    ["*/10 * * * *", "*/10 * * * *"],
  ])("describes %s as %s", (cron, text) => {
    expect(describeCron(cron, "en").replaceAll(/\s/g, " ")).toBe(text)
  })
})

describe("nextRuns", () => {
  const from = new Date("2026-11-10T12:00:00Z")

  test("lists the next times in the schedule's time zone", () => {
    const runs = nextRuns({ cron: "0 9 * * *", timezone: "Asia/Tokyo" }, from, 3)
    expect(runs.map((run) => run.toISOString())).toEqual([
      "2026-11-11T00:00:00.000Z",
      "2026-11-12T00:00:00.000Z",
      "2026-11-13T00:00:00.000Z",
    ])
  })

  test("skips the weekend for weekdays", () => {
    const friday = new Date("2026-11-13T12:00:00Z")
    const runs = nextRuns({ cron: "0 9 * * 1-5", timezone: "UTC" }, friday, 2)
    expect(runs.map((run) => run.toISOString())).toEqual(["2026-11-16T09:00:00.000Z", "2026-11-17T09:00:00.000Z"])
  })

  test("is empty for an invalid expression", () => {
    expect(nextRuns({ cron: "not cron", timezone: "UTC" }, from, 3)).toEqual([])
    expect(nextRuns({ cron: "0 9 30 2 *", timezone: "UTC" }, from, 3)).toEqual([])
  })
})

describe("weekAhead", () => {
  const tuesdayNoonTokyo = new Date("2026-11-10T03:00:00Z")
  const summary = (cron: string, timezone = "Asia/Tokyo") =>
    weekAhead({ cron, timezone }, tuesdayNoonTokyo).map((slot) => `${slot.day}:${slot.runs.length}`)

  test("starts today in the schedule's time zone and spans seven days", () => {
    const slots = weekAhead({ cron: "0 9 * * *", timezone: "Asia/Tokyo" }, tuesdayNoonTokyo)
    expect(slots.map((slot) => slot.weekday)).toEqual([2, 3, 4, 5, 6, 0, 1])
    expect(slots.map((slot) => slot.day)).toEqual([10, 11, 12, 13, 14, 15, 16])
  })

  test("leaves today empty once its run has passed", () => {
    expect(summary("0 9 * * *")).toEqual(["10:0", "11:1", "12:1", "13:1", "14:1", "15:1", "16:1"])
  })

  test("leaves the weekend empty for weekdays", () => {
    expect(summary("0 18 * * 1-5")).toEqual(["10:1", "11:1", "12:1", "13:1", "14:0", "15:0", "16:1"])
  })

  test("counts every run of an hourly schedule", () => {
    expect(summary("0 * * * *")).toEqual(["10:11", "11:24", "12:24", "13:24", "14:24", "15:24", "16:24"])
  })

  test("uses the calendar day of the time zone, not UTC", () => {
    const slots = weekAhead({ cron: "0 9 * * *", timezone: "America/Los_Angeles" }, tuesdayNoonTokyo)
    expect(slots[0]).toMatchObject({ weekday: 1, day: 9 })
  })

  test("has no runs for an invalid expression", () => {
    expect(summary("0 9 30 2 *").every((slot) => slot.endsWith(":0"))).toBe(true)
  })
})
