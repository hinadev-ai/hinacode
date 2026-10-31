import type { Ref } from "react"
import type { Palette } from "@/constants/theme"
import type { Scheme } from "@/hooks/use-theme"

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

/** The desktop terminal's 16 colors from `src/renderer/index.css`, each at least 4.5:1 on its background. */
const ansi: Record<Scheme, Record<string, string>> = {
  light: {
    black: "#161616",
    red: "#c51e21",
    green: "#137738",
    yellow: "#966800",
    blue: "#195cc7",
    magenta: "#922ba8",
    cyan: "#007785",
    white: "#555555",
    brightBlack: "#636363",
    brightRed: "#d42325",
    brightGreen: "#17843f",
    brightYellow: "#9c6a00",
    brightBlue: "#296cd8",
    brightMagenta: "#a23db8",
    brightCyan: "#008192",
    brightWhite: "#747474",
  },
  dark: {
    black: "#3a3a3a",
    red: "#f66d67",
    green: "#61cb7c",
    yellow: "#e8c35a",
    blue: "#6aa7f4",
    magenta: "#d489e5",
    cyan: "#64d1d7",
    white: "#d4d4d4",
    brightBlack: "#808080",
    brightRed: "#ff8b83",
    brightGreen: "#7fe196",
    brightYellow: "#f3da7a",
    brightBlue: "#8dc1ff",
    brightMagenta: "#e6a5f5",
    brightCyan: "#88e7ec",
    brightWhite: "#fafafa",
  },
}

export const xtermTheme = (theme: Palette, scheme: Scheme) => ({
  background: theme.background,
  foreground: theme.text,
  cursor: theme.text,
  selectionBackground: theme.surfaceStrong,
  ...ansi[scheme],
})
