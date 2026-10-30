import { expect, test } from "vitest"
import { hidUsage, keystrokesFor } from "./hidUsage.ts"

test.each([
  ["KeyA", 0x04],
  ["KeyZ", 0x1d],
  ["Digit1", 0x1e],
  ["Digit9", 0x26],
  ["Digit0", 0x27],
  ["Enter", 0x28],
  ["Space", 0x2c],
  ["Slash", 0x38],
  ["ArrowUp", 0x52],
  ["MetaLeft", 0xe3],
])("maps %s to HID usage %i", (code, usage) => expect(hidUsage(code)).toBe(usage))

test("ignores keys the device has no usage for", () => {
  expect(hidUsage("F13")).toBeUndefined()
  expect(hidUsage("constructor")).toBeUndefined()
})

test("types text as US layout keystrokes", () => {
  expect(keystrokesFor("aZ 1!/?\n")).toEqual([
    { usage: 0x04, shift: false },
    { usage: 0x1d, shift: true },
    { usage: 0x2c, shift: false },
    { usage: 0x1e, shift: false },
    { usage: 0x1e, shift: true },
    { usage: 0x38, shift: false },
    { usage: 0x38, shift: true },
    { usage: 0x28, shift: false },
  ])
})

test("refuses text a US keyboard cannot type", () => expect(keystrokesFor("日本語")).toBeUndefined())
