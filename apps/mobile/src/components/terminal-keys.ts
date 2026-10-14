import type { IconName } from "@/components/icon"

export type TerminalKey = "escape" | "tab" | "up" | "down" | "left" | "right"

/** The keys a phone keyboard lacks, in the order the key row shows them. */
export const terminalKeys: readonly { key: TerminalKey; label: string; icon?: IconName }[] = [
  { key: "escape", label: "Esc" },
  { key: "tab", label: "Tab" },
  { key: "left", label: "Left arrow", icon: "RiArrowLeftSLine" },
  { key: "up", label: "Up arrow", icon: "RiArrowUpSLine" },
  { key: "down", label: "Down arrow", icon: "RiArrowDownSLine" },
  { key: "right", label: "Right arrow", icon: "RiArrowRightSLine" },
]

const arrowCodes = { up: "A", down: "B", right: "C", left: "D" } as const

/**
 * What the key sends to the shell. Arrows follow the cursor key mode the program asked for:
 * full-screen programs such as vim and less switch to the `ESC O` form.
 */
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

/** Applies Ctrl to the first character typed, the way a hardware keyboard does: Ctrl+C sends 0x03. */
export const withCtrl = (data: string): string => {
  const first = data[0]
  if (first === undefined) return data
  const upper = first.toUpperCase()
  const code = upper.charCodeAt(0)
  const control = first === "?" ? 0x7f : first === " " ? 0 : code >= 0x40 && code <= 0x5f ? code & 0x1f : undefined
  return control === undefined ? data : String.fromCharCode(control) + data.slice(1)
}
