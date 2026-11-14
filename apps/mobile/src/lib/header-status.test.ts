import { expect, it } from "vitest"
import { headerStatus } from "./header-status"

const at = (status: Parameters<typeof headerStatus>[0]["status"], interruptedAt: string | null = null) => ({
  status,
  interruptedAt,
})

it("shows a running thread with an open request as awaiting approval", () => {
  expect(headerStatus(at("running"), true)).toBe("awaiting_approval")
  expect(headerStatus(at("running"), false)).toBe("running")
  expect(headerStatus(at("limited"), true)).toBe("limited")
  expect(headerStatus(at("idle"), true)).toBe("idle")
})

it("shows an idle thread a restart stopped as interrupted, and an archived one as archived", () => {
  expect(headerStatus(at("idle", "2026-11-13T00:00:00.000Z"), false)).toBe("interrupted")
  expect(headerStatus(at("archived", "2026-11-13T00:00:00.000Z"), false)).toBe("archived")
})
