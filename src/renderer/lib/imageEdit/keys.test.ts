import { describe, expect, it } from "vitest"
import { type KeyInput, keyAction } from "./keys.ts"

const press = (key: string, modifiers: Partial<KeyInput> = {}): KeyInput => ({
  key,
  shiftKey: false,
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  ...modifiers,
})

describe("keyAction", () => {
  it("maps Ctrl and Cmd chords to undo and redo, and ignores other chords", () => {
    expect(keyAction(press("z", { ctrlKey: true }))).toEqual({ type: "undo" })
    expect(keyAction(press("Z", { metaKey: true, shiftKey: true }))).toEqual({ type: "redo" })
    expect(keyAction(press("y", { ctrlKey: true }))).toEqual({ type: "redo" })
    expect(keyAction(press("r", { ctrlKey: true }))).toBeNull()
  })

  it("nudges ten pixels with Shift", () => {
    expect(keyAction(press("ArrowLeft"))).toEqual({ type: "nudge", dx: -1, dy: 0 })
    expect(keyAction(press("ArrowDown", { shiftKey: true }))).toEqual({ type: "nudge", dx: 0, dy: 10 })
  })

  it("picks colors by number and tools by letter, and leaves Alt chords alone", () => {
    expect(keyAction(press("1"))).toEqual({ type: "color", color: "#ff375f" })
    expect(keyAction(press("0"))).toBeNull()
    expect(keyAction(press("R"))).toEqual({ type: "tool", tool: "rect" })
    expect(keyAction(press("r", { altKey: true }))).toBeNull()
  })
})
