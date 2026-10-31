import { describe, expect, it } from "vitest"
import { BOAT_SCREEN, xdotoolScript } from "./xdotool.ts"

describe("xdotoolScript", () => {
  it("moves and clicks with the X11 button numbers", () => {
    expect(xdotoolScript([{ type: "click", x: 100, y: 50, button: "right", clicks: 1 }])).toBe(
      "xdotool mousemove 100 50\nxdotool click 3",
    )
    expect(xdotoolScript([{ type: "click", x: 1, y: 2, button: "left", clicks: 2 }])).toContain(
      "xdotool click --repeat 2 --delay 80 1",
    )
  })

  it("drags with the button held through interpolated moves", () => {
    const script = xdotoolScript([{ type: "drag", x: 0, y: 0, toX: 100, toY: 10 }])
    const lines = script.split("\n")
    expect(lines[0]).toBe("xdotool mousemove 0 0")
    expect(lines[1]).toBe("xdotool mousedown 1")
    expect(lines.at(-1)).toBe("xdotool mouseup 1")
    expect(script).toContain("xdotool mousemove 100 10")
  })

  it("scrolls with wheel buttons", () => {
    expect(xdotoolScript([{ type: "scroll", x: 10, y: 10, direction: "down", amount: 3 }])).toContain(
      "xdotool click --repeat 3 5",
    )
  })

  it("quotes typed text and keys for the shell", () => {
    expect(xdotoolScript([{ type: "type", text: "it's $HOME" }])).toBe(
      `xdotool type --clearmodifiers --delay 1 -- 'it'\\''s $HOME'`,
    )
    expect(xdotoolScript([{ type: "key", keys: "ctrl+l Return" }])).toBe(
      "xdotool key --clearmodifiers 'ctrl+l'\nxdotool key --clearmodifiers 'Return'",
    )
  })

  it("refuses points outside the boat screen and unknown modifiers", () => {
    expect(() => xdotoolScript([{ type: "move", x: BOAT_SCREEN.width, y: 0 }])).toThrow(
      `x must be between 0 and ${BOAT_SCREEN.width - 1}`,
    )
    expect(() => xdotoolScript([{ type: "key", keys: "hyper+x" }])).toThrow('Unknown key "hyper"')
    expect(() => xdotoolScript([{ type: "key", keys: "  " }])).toThrow("keys is empty")
  })

  it("refuses control characters in typed text", () => {
    expect(() => xdotoolScript([{ type: "type", text: "ab" }])).toThrow("control character")
  })
})
