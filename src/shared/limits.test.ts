import { describe, expect, test } from "@effect/vitest"
import { accountRoom, type LimitWindow, roomiest, spentWindow } from "./limits.ts"

const now = Date.parse("2026-10-12T12:00:00.000Z")
const inSeconds = (seconds: number) => new Date(now + seconds * 1000).toISOString()
const hour = 60 * 60
const day = 24 * hour
const used = (usedPercent: number): LimitWindow => ({ window: { kind: "session" }, usedPercent, resetsAt: null })

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

describe("roomiest", () => {
  const fable: LimitWindow = { window: { kind: "model", name: "Fable" }, usedPercent: 100, resetsAt: null }

  test("picks the least used account that can run the model", () => {
    const accounts = [
      { id: "busy", ...accountRoom([used(70)], "claude-fable-5-1") },
      { id: "unknown", ...accountRoom([], "claude-fable-5-1") },
      { id: "spent", ...accountRoom([used(10), fable], "claude-fable-5-1") },
      { id: "roomy", ...accountRoom([used(20)], "claude-fable-5-1") },
    ]
    expect(roomiest(accounts)?.id).toBe("roomy")
  })

  test("is undefined when no account has room", () => {
    expect(roomiest([{ id: "spent", ...accountRoom([used(100)], "claude-sonnet-5-5") }])).toBeUndefined()
  })
})
