import { describe, expect, test } from "@effect/vitest"
import { defaultScheduleDraft, describeCron, fromCron, nextRuns, type ScheduleDraft, toCron } from "./schedule.ts"

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
