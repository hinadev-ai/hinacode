import { VmInputError, type VmAction } from "./rfb.ts"

export const BOAT_SCREEN = { width: 1920, height: 1080 } as const

const BUTTONS = { left: 1, middle: 2, right: 3 } as const
const WHEEL = { up: 4, down: 5, left: 6, right: 7 } as const
const DRAG_MOVES = 10
const MODIFIERS = new Set(["ctrl", "control", "shift", "alt", "super", "win", "cmd", "meta"])

const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`

const checkCoordinate = (name: string, value: number, size: number) => {
  if (!Number.isInteger(value) || value < 0 || value >= size)
    throw new VmInputError({ message: `${name} must be between 0 and ${size - 1}` })
}

const checkPoint = (names: readonly [string, string], x: number, y: number) => {
  checkCoordinate(names[0], x, BOAT_SCREEN.width)
  checkCoordinate(names[1], y, BOAT_SCREEN.height)
}

const checkText = (text: string) => {
  for (const character of text) {
    if (character === "\n" || character === "\t" || character === "\r") continue
    const codePoint = character.codePointAt(0)!
    if (codePoint < 0x20 || codePoint === 0x7f) {
      throw new VmInputError({
        message: `Cannot type the control character U+${codePoint.toString(16).padStart(4, "0")}. Use vm_key for special keys.`,
      })
    }
  }
}

const checkChord = (chord: string) => {
  const parts =
    chord === "+" ? ["+"] : chord.endsWith("++") ? [...chord.slice(0, -2).split("+"), "+"] : chord.split("+")
  const name = parts.at(-1)!
  for (const modifier of parts.slice(0, -1)) {
    if (!MODIFIERS.has(modifier.toLowerCase()))
      throw new VmInputError({
        message: `Unknown key "${modifier}" in "${chord}". Use names like Return, Tab, Escape, BackSpace, Delete, Left, Page_Down, F5 or space, or a single character, with modifiers ctrl, shift, alt or super, for example ctrl+shift+t.`,
      })
  }
  if ([...name].length !== 1 && !/^[A-Za-z0-9_]+$/.test(name))
    throw new VmInputError({
      message: `Unknown key "${name}" in "${chord}". Use names like Return, Tab, Escape, BackSpace, Delete, Left, Page_Down, F5 or space, or a single character, with modifiers ctrl, shift, alt or super, for example ctrl+shift+t.`,
    })
}

const actionLines = (action: VmAction): ReadonlyArray<string> => {
  switch (action.type) {
    case "move":
      checkPoint(["x", "y"], action.x, action.y)
      return [`xdotool mousemove ${action.x} ${action.y}`]
    case "click": {
      checkPoint(["x", "y"], action.x, action.y)
      const repeat = action.clicks > 1 ? ` --repeat ${action.clicks} --delay 80` : ""
      return [`xdotool mousemove ${action.x} ${action.y}`, `xdotool click${repeat} ${BUTTONS[action.button]}`]
    }
    case "drag": {
      checkPoint(["x", "y"], action.x, action.y)
      checkPoint(["toX", "toY"], action.toX, action.toY)
      const moves = Array.from({ length: DRAG_MOVES }, (_, index) => {
        const progress = (index + 1) / DRAG_MOVES
        const x = Math.round(action.x + (action.toX - action.x) * progress)
        const y = Math.round(action.y + (action.toY - action.y) * progress)
        return `xdotool mousemove ${x} ${y}; sleep 0.015`
      })
      return [`xdotool mousemove ${action.x} ${action.y}`, "xdotool mousedown 1", ...moves, "xdotool mouseup 1"]
    }
    case "scroll":
      checkPoint(["x", "y"], action.x, action.y)
      return [
        `xdotool mousemove ${action.x} ${action.y}`,
        `xdotool click --repeat ${action.amount} ${WHEEL[action.direction]}`,
      ]
    case "type":
      checkText(action.text)
      return action.text === "" ? [] : [`xdotool type --clearmodifiers --delay 1 -- ${shellQuote(action.text)}`]
    case "key": {
      const chords = action.keys.trim().split(/\s+/).filter(Boolean)
      if (chords.length === 0)
        throw new VmInputError({ message: "keys is empty. Pass a key such as Return or ctrl+l." })
      chords.forEach(checkChord)
      return chords.map((chord) => `xdotool key --clearmodifiers ${shellQuote(chord)}`)
    }
  }
}

export const xdotoolScript = (actions: ReadonlyArray<VmAction>): string => actions.flatMap(actionLines).join("\n")
