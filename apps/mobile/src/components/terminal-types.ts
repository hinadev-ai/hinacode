import type { Ref } from "react"
import type { Palette } from "@/constants/theme"

export interface TerminalViewHandle {
  readonly write: (data: string) => void
}

export interface TerminalViewProps {
  readonly ref: Ref<TerminalViewHandle>
  readonly theme: Palette
  readonly onInput: (data: string) => void
  /** Called with the fitted grid size whenever it changes, first once the terminal has laid out. */
  readonly onSize: (cols: number, rows: number) => void
  /** Called when the program switches arrow keys between normal and application mode. */
  readonly onCursorMode: (applicationCursor: boolean) => void
}

export const xtermTheme = (theme: Palette) => ({
  background: theme.background,
  foreground: theme.text,
  cursor: theme.text,
  selectionBackground: theme.surfaceStrong,
})
