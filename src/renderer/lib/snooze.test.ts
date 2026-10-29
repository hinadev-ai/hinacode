import { describe, expect, test } from "@effect/vitest"
import { parseSnoozeTime } from "./parseSnoozeTime.ts"
import { formatSnoozeTime, snoozePresets } from "./snooze.ts"

// Local times, so the expectations hold in any time zone. 2026-10-26 is a Monday.
const local = (day: number, hour: number, minute = 0) => new Date(2026, 9, day, hour, minute)

const presets = (now: Date) => snoozePresets(now).map(({ id, at }) => [id, at])

describe("snoozePresets", () => {
  test("a weekday afternoon offers every preset", () => {
    expect(presets(local(27, 14, 20))).toStrictEqual([
      ["inAnHour", local(27, 15, 20)],
      ["thisEvening", local(27, 18)],
      ["tomorrow", local(28, 9)],
      ["nextWeek", local(2 + 31, 9)],
    ])
  })

  test("drops this evening once it is an hour or less away", () => {
    expect(presets(local(27, 17)).map(([id]) => id)).toStrictEqual(["inAnHour", "tomorrow", "nextWeek"])
  })

  test("on a Monday, next week is the Monday after", () => {
    expect(snoozePresets(local(26, 8)).find(({ id }) => id === "nextWeek")?.at).toStrictEqual(local(2 + 31, 9))
  })

  test("on a Sunday, tomorrow is next Monday, so it is offered once", () => {
    expect(presets(local(25, 20))).toStrictEqual([
      ["inAnHour", local(25, 21)],
      ["tomorrow", local(26, 9)],
    ])
  })
})

describe("parseSnoozeTime", () => {
  const now = local(26, 15)

  test.each([
    ["monday 8:00", local(2 + 31, 8)],
    ["mon 8am", local(2 + 31, 8)],
    ["tomorrow 14:30", local(27, 14, 30)],
    ["in 2 hours", local(26, 17)],
    ["8:00", local(27, 8)],
    ["friday", local(30, 9)],
    ["tonight", local(26, 22)],
  ])("reads %s", (text, expected) => {
    expect(parseSnoozeTime(text, now, "en")).toStrictEqual({ status: "ok", at: expected })
  })

  test("reads Japanese and Traditional Chinese, and English in either", () => {
    expect(parseSnoozeTime("月曜日 8:00", now, "ja")).toStrictEqual({ status: "ok", at: local(2 + 31, 8) })
    expect(parseSnoozeTime("明天 上午9點", now, "zh-TW")).toStrictEqual({ status: "ok", at: local(27, 9) })
    expect(parseSnoozeTime("tomorrow 10:00", now, "ja")).toStrictEqual({ status: "ok", at: local(27, 10) })
    expect(parseSnoozeTime("明日 14:30", now, "ja")).toStrictEqual({ status: "ok", at: local(27, 14, 30) })
    expect(parseSnoozeTime("兩小時後", now, "zh-TW")).toStrictEqual({ status: "ok", at: local(26, 17) })
  })

  test("a bare weekday that is today and past 9:00 means next week's", () => {
    const mondayMorning = local(26, 10)
    expect(parseSnoozeTime("monday", mondayMorning, "en")).toStrictEqual({ status: "ok", at: local(2 + 31, 9) })
    expect(parseSnoozeTime("月曜", mondayMorning, "ja")).toStrictEqual({ status: "ok", at: local(2 + 31, 9) })
  })

  test("tells empty, unreadable and past text apart", () => {
    expect(parseSnoozeTime("  ", now, "en")).toStrictEqual({ status: "empty" })
    expect(parseSnoozeTime("whenever", now, "en")).toStrictEqual({ status: "unreadable" })
    expect(parseSnoozeTime("today 8:00", now, "en")).toStrictEqual({ status: "past", at: local(26, 8) })
  })
})

describe("formatSnoozeTime", () => {
  const now = local(26, 15)

  test.each([
    [local(26, 18), "6:00 PM"],
    [local(27, 9), "Tue 9:00 AM"],
    [local(2 + 31, 8), "Nov 2, 8:00 AM"],
  ])("formats %s", (time, expected) => {
    expect(formatSnoozeTime(time, now, "en")).toBe(expected)
  })
})
