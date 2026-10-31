import { describe, expect, test } from "@effect/vitest"
import { resetCopy } from "./UsageLimitCallout.tsx"

describe("resetCopy", () => {
  const at = "2026-10-20T00:00:00Z"

  test("says when the limit resets while that time is ahead", () => {
    expect(resetCopy(at, Date.parse("2026-10-19T00:00:00Z"))).toMatch(/^Resets at /)
  })

  test("keeps saying resets at while main's grace after the reset still runs", () => {
    expect(resetCopy(at, Date.parse("2026-10-20T00:00:55Z"))).toMatch(/^Resets at /)
  })

  test("says the limit reset once that time and the grace have passed", () => {
    expect(resetCopy(at, Date.parse("2026-10-20T00:01:00Z"))).toMatch(/^Reset at .+\.$/)
  })

  test("has nothing to say about a time it cannot read", () => {
    expect(resetCopy("soon", Date.parse("2026-10-31T00:00:00Z"))).toBe(null)
  })
})
