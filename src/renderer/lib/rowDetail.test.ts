import { describe, expect, test } from "@effect/vitest"
import { rowDetail } from "./rowDetail.ts"

const base = {
  line: undefined,
  limit: null,
  attention: undefined,
  showActivity: false,
  now: Date.parse("2026-11-04T12:00:00.000Z"),
  locale: "en",
} as const

const text = (input: Partial<Parameters<typeof rowDetail>[0]> & Pick<Parameters<typeof rowDetail>[0], "state">) =>
  rowDetail({ ...base, ...input })?.text

describe("rowDetail", () => {
  test("says what a blocked agent is asking", () => {
    const line = { text: "pnpm install", code: true, kind: "ask" } as const
    expect(text({ state: "awaiting_approval", line })).toBe("pnpm install")
  })

  test("falls back to words when the ask is unknown, such as after a reload", () => {
    expect(text({ state: "awaiting_approval" })).toBe("Awaiting approval")
    expect(text({ state: "unseen_failed" })).toBe("Failed")
  })

  test("a line of the wrong kind never stands in for the current state", () => {
    const failure = { text: "pnpm install exited 1", code: false, kind: "failure" } as const
    expect(text({ state: "awaiting_approval", line: failure })).toBe("Awaiting approval")
    expect(text({ state: "running", line: failure, showActivity: true })).toBeUndefined()
  })

  test("names when a usage limit resets, until that time has passed", () => {
    const limit = (at: string) => ({ kind: "usage", message: "", reset: { at, autoResume: false } }) as const
    expect(text({ state: "limited", limit: limit("2026-11-04T23:00:00.000Z") })).toMatch(/^Resets /)
    expect(text({ state: "limited", limit: limit("2026-11-04T01:00:00.000Z") })).toBe("Usage limit")
    expect(text({ state: "limited" })).toBe("Usage limit")
  })

  test("shows an agent's activity only when asked", () => {
    const line = { text: "pnpm test", code: true, kind: "activity" } as const
    expect(text({ state: "running", line })).toBeUndefined()
    expect(text({ state: "running", line, showActivity: true })).toBe("pnpm test")
  })

  test("names a pull request problem in words, whatever the row's status", () => {
    expect(text({ state: "pr_checksFailing", attention: "checksFailing" })).toBe("Checks failing")
    expect(text({ state: "unseen_completed", attention: "conflicting" })).toBe("Conflicts")
    expect(text({ state: "idle", attention: "changesRequested" })).toBe("Changes requested")
    expect(text({ state: "idle" })).toBeUndefined()
  })
})
