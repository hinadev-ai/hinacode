import { describe, expect, test } from "@effect/vitest"
import { chordFromEvent, chordLabels, formatChord, toTinykeys } from "./chord.ts"

// Node reports `navigator.platform` as the OS, so these run as the non-mac branch.
const keydown = (init: Partial<KeyboardEvent> & { code: string; key: string }) =>
  ({ ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...init }) as KeyboardEvent

describe("chordFromEvent", () => {
  test("canonicalizes modifiers in a fixed order and keys from the physical code", () => {
    expect(chordFromEvent(keydown({ code: "KeyN", key: "N", ctrlKey: true, shiftKey: true }))).toBe("mod+shift+n")
    expect(chordFromEvent(keydown({ code: "Digit1", key: "!", shiftKey: true, altKey: true }))).toBe("alt+shift+1")
    expect(chordFromEvent(keydown({ code: "BracketRight", key: "]", ctrlKey: true, metaKey: true }))).toBe("mod+meta+]")
  })

  test("is null while only modifiers are held", () => {
    expect(chordFromEvent(keydown({ code: "ShiftLeft", key: "Shift", shiftKey: true }))).toBeNull()
    expect(chordFromEvent(keydown({ code: "ControlLeft", key: "Control", ctrlKey: true }))).toBeNull()
  })

  test("falls back to the key when the event carries no code", () => {
    expect(chordFromEvent(keydown({ code: "", key: "Enter" }))).toBe("enter")
  })
})

describe("toTinykeys", () => {
  test("maps canonical chords to tinykeys patterns", () => {
    expect(toTinykeys("mod+shift+]")).toBe("$mod+Shift+BracketRight")
    expect(toTinykeys("mod+n")).toBe("$mod+KeyN")
    expect(toTinykeys("alt+1")).toBe("Alt+Digit1")
    expect(toTinykeys("ctrl+escape")).toBe("Control+(escape)")
  })
})

describe("labels", () => {
  test("spells out modifiers and capitalizes the key", () => {
    expect(chordLabels("mod+shift+n")).toStrictEqual(["Ctrl", "Shift", "N"])
    expect(chordLabels("alt+escape")).toStrictEqual(["Alt", "Escape"])
    expect(formatChord("mod+,")).toBe("Ctrl+,")
  })
})
