import { describe, expect, it } from "vitest"
import { defaultPreferences, parsePreferences } from "./preferences"

describe("parsePreferences", () => {
  it("uses the defaults before anything was stored", () => {
    expect(parsePreferences(null)).toEqual(defaultPreferences)
  })

  it("reads what the app stored", () => {
    const stored = {
      appearance: "dark",
      notifications: { completed: false, needsInput: true, failed: true },
      homeTab: "threads",
      sidebarHidden: true,
    }
    expect(parsePreferences(JSON.stringify(stored))).toEqual(stored)
  })

  it("fills keys an older app never wrote", () => {
    expect(parsePreferences(JSON.stringify({ appearance: "light" }))).toEqual({
      ...defaultPreferences,
      appearance: "light",
    })
  })

  it("falls back to the defaults for unreadable data", () => {
    expect(parsePreferences("{not json")).toEqual(defaultPreferences)
    expect(parsePreferences(JSON.stringify({ appearance: "sepia" }))).toEqual(defaultPreferences)
  })
})
