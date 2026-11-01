import { expect, test } from "@effect/vitest"
import { formatWorkDuration } from "./workDuration.ts"

test("formats short turns in seconds and longer turns as m:ss or h:mm:ss", () => {
  for (const [ms, expected] of [
    [0, "<1s"],
    [999, "<1s"],
    [1_000, "1s"],
    [4_200, "4s"],
    [59_999, "59s"],
    [60_000, "1:00"],
    [485_000, "8:05"],
    [3_599_999, "59:59"],
    [3_600_000, "1:00:00"],
    [3_723_000, "1:02:03"],
    [-1_000, "<1s"],
    [Number.NaN, "<1s"],
  ] as const) {
    expect(formatWorkDuration(ms)).toBe(expected)
  }
})
