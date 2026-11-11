import type { IconName } from "@/components/icon"
import { copy } from "@/lib/copy"

export type TerminalKey = "escape" | "tab" | "up" | "down" | "left" | "right"

export const terminalKeys: readonly { key: TerminalKey; label: string; icon?: IconName }[] = [
  { key: "escape", label: "esc" },
  { key: "tab", label: "tab" },
  { key: "up", label: copy("mobile_terminal_key_up"), icon: "ArrowUp" },
  { key: "down", label: copy("mobile_terminal_key_down"), icon: "ArrowDown" },
  { key: "left", label: copy("mobile_terminal_key_left"), icon: "ArrowLeft" },
  { key: "right", label: copy("mobile_terminal_key_right"), icon: "ArrowRight" },
]

const arrowCodes = { up: "A", down: "B", right: "C", left: "D" } as const

export const keySequence = (key: TerminalKey, applicationCursor: boolean): string => {
  switch (key) {
    case "escape":
      return "\x1b"
    case "tab":
      return "\t"
    default:
      return `${applicationCursor ? "\x1bO" : "\x1b["}${arrowCodes[key]}`
  }
}

export const withCtrl = (data: string): string => {
  const first = data[0]
  if (first === undefined) return data
  const upper = first.toUpperCase()
  const code = upper.charCodeAt(0)
  const control = first === "?" ? 0x7f : first === " " ? 0 : code >= 0x40 && code <= 0x5f ? code & 0x1f : undefined
  return control === undefined ? data : String.fromCharCode(control) + data.slice(1)
}
