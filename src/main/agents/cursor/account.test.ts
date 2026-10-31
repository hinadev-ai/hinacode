import { describe, expect, test } from "@effect/vitest"
import { parseCursorStatus } from "./account.ts"

describe("parseCursorStatus", () => {
  test("reads a signed-out CLI", () => {
    expect(parseCursorStatus("Not logged in\n")).toStrictEqual({ type: "signedOut" })
  })

  test("reads the signed-in email", () => {
    expect(parseCursorStatus("\u001b[32m✓\u001b[0m Logged in as dev.name+cursor@example.co.jp\n")).toStrictEqual({
      type: "subscription",
      email: "dev.name+cursor@example.co.jp",
      plan: null,
      organization: null,
    })
  })

  test("falls back to an external account for output it does not recognize", () => {
    expect(parseCursorStatus("Logged in\n")).toStrictEqual({ type: "external", service: "Cursor" })
  })
})
