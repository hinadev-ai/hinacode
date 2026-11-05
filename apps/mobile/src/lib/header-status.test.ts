import { expect, it } from "vitest"
import { headerStatus } from "./header-status"

it("shows a running thread with an open request as awaiting approval", () => {
  expect(headerStatus("running", true)).toBe("awaiting_approval")
  expect(headerStatus("running", false)).toBe("running")
  expect(headerStatus("limited", true)).toBe("limited")
  expect(headerStatus("idle", true)).toBe("idle")
})
