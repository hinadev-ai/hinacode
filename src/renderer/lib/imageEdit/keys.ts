import { type Color, PALETTE } from "./document.ts"
import { TOOL_KEYS, type Tool } from "./gesture.ts"

export type KeyAction =
  | { readonly type: "undo" | "redo" | "done" | "delete" }
  | { readonly type: "nudge"; readonly dx: number; readonly dy: number }
  | { readonly type: "color"; readonly color: Color }
  | { readonly type: "tool"; readonly tool: Tool }

export interface KeyInput {
  readonly key: string
  readonly shiftKey: boolean
  readonly altKey: boolean
  readonly ctrlKey: boolean
  readonly metaKey: boolean
}

const NUDGES: Readonly<Record<string, readonly [number, number]>> = {
  arrowleft: [-1, 0],
  arrowright: [1, 0],
  arrowup: [0, -1],
  arrowdown: [0, 1],
}

export const keyAction = (input: KeyInput): KeyAction | null => {
  const key = input.key.toLowerCase()
  if (input.metaKey || input.ctrlKey) {
    if (key === "y" || (key === "z" && input.shiftKey)) return { type: "redo" }
    return key === "z" ? { type: "undo" } : null
  }
  if (input.altKey) return null
  if (key === "enter") return { type: "done" }
  if (key === "delete" || key === "backspace") return { type: "delete" }
  const nudge = NUDGES[key]
  if (nudge) {
    const step = input.shiftKey ? 10 : 1
    return { type: "nudge", dx: nudge[0] * step, dy: nudge[1] * step }
  }
  const color = PALETTE[Number(input.key) - 1]
  if (color) return { type: "color", color }
  const tool = TOOL_KEYS.find(([, letter]) => letter === key)?.[0]
  return tool ? { type: "tool", tool } : null
}
