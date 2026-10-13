import { describe, expect, it } from "@effect/vitest"
import { encodeAction, type VmAction } from "./rfb.ts"
import { decodeClientMessages, type RfbEvent } from "./testing.ts"

const screen = { width: 1280, height: 800 }

const events = (action: VmAction) =>
  decodeClientMessages(
    Buffer.concat(encodeAction(action, screen).flatMap((step) => (step instanceof Uint8Array ? [step] : []))),
  )

const key = (keysym: number, down: boolean): RfbEvent => ({ type: "key", keysym, down })
const tap = (keysym: number) => [key(keysym, true), key(keysym, false)]
const pointer = (x: number, y: number, mask: number): RfbEvent => ({ type: "pointer", x, y, mask })

const CONTROL_L = 0xffe3
const SHIFT_L = 0xffe1

describe("encodeAction", () => {
  it.each<[string, VmAction, ReadonlyArray<RfbEvent>]>([
    [
      "ctrl+shift+t holds both modifiers around an uppercase T",
      { type: "key", keys: "ctrl+shift+t" },
      [key(CONTROL_L, true), key(SHIFT_L, true), ...tap(0x54), key(SHIFT_L, false), key(CONTROL_L, false)],
    ],
    ["Return", { type: "key", keys: "Return" }, tap(0xff0d)],
    [
      "names are case-insensitive and run in order",
      { type: "key", keys: "escape alt+F4" },
      [...tap(0xff1b), key(0xffe9, true), ...tap(0xffc1), key(0xffe9, false)],
    ],
    [
      "a single character is its own keysym",
      { type: "key", keys: "ctrl+A" },
      [key(CONTROL_L, true), ...tap(0x61), key(CONTROL_L, false)],
    ],
    ["typing Latin and CJK", { type: "type", text: "aB世" }, [...tap(0x61), ...tap(0x42), ...tap(0x01004e16)]],
    ["typing a newline and a tab", { type: "type", text: "a\n\t" }, [...tap(0x61), ...tap(0xff0d), ...tap(0xff09)]],
    [
      "scroll down 2",
      { type: "scroll", x: 10, y: 20, direction: "down", amount: 2 },
      [pointer(10, 20, 0), pointer(10, 20, 16), pointer(10, 20, 0), pointer(10, 20, 16), pointer(10, 20, 0)],
    ],
    [
      "double click",
      { type: "click", x: 640, y: 400, button: "left", clicks: 2 },
      [pointer(640, 400, 0), pointer(640, 400, 1), pointer(640, 400, 0), pointer(640, 400, 1), pointer(640, 400, 0)],
    ],
    [
      "right click",
      { type: "click", x: 1, y: 2, button: "right", clicks: 1 },
      [pointer(1, 2, 0), pointer(1, 2, 4), pointer(1, 2, 0)],
    ],
  ])("%s", (_, action, expected) => {
    expect(events(action)).toStrictEqual(expected)
  })

  it("drag presses at the start, moves with the button held and releases at the end", () => {
    const result = events({ type: "drag", x: 0, y: 0, toX: 100, toY: 50 })
    expect(result.slice(0, 2)).toStrictEqual([pointer(0, 0, 0), pointer(0, 0, 1)])
    expect(result.at(-2)).toStrictEqual(pointer(100, 50, 1))
    expect(result.at(-1)).toStrictEqual(pointer(100, 50, 0))
    expect(result.slice(2, -1).every((event) => event.type === "pointer" && event.mask === 1)).toBe(true)
    expect(result.length).toBeGreaterThanOrEqual(12)
  })

  it("rejects coordinates outside the screen", () => {
    expect(() => events({ type: "move", x: 1280, y: 0 })).toThrow("x must be between 0 and 1279")
    expect(() => events({ type: "drag", x: 0, y: 0, toX: 5, toY: 800 })).toThrow("toY must be between 0 and 799")
  })

  it("rejects an unknown key name and suggests valid ones", () => {
    expect(() => events({ type: "key", keys: "ctrl+Bogus" })).toThrow(/Unknown key "Bogus".*Return/)
  })
})
