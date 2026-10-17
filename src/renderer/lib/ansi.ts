import Anser from "anser"
import type { CSSProperties } from "react"

export interface AnsiSegment {
  readonly text: string
  readonly style: CSSProperties
}

const names = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"]
const classes = [...names.map((name) => `ansi-${name}`), ...names.map((name) => `ansi-bright-${name}`)]

/**
 * The 16 named colors use the integrated terminal's palette (`--term-color-N` in index.css), so they follow
 * the app theme. 256-color palette entries above 15 have no theme color and render uncolored.
 */
const color = (name: string | null, truecolor: string | null): string | undefined => {
  if (truecolor !== null) return `rgb(${truecolor})`
  const index = classes.indexOf(name ?? "")
  return index === -1 ? undefined : `var(--term-color-${index})`
}

/** Splits terminal output into styled runs. Escape codes that are not colors or text styles are dropped. */
export function ansiSegments(text: string): Array<AnsiSegment> {
  return Anser.ansiToJson(text, { use_classes: true, remove_empty: true }).flatMap((entry) => {
    const { decorations } = entry
    if (decorations.includes("hidden")) return []
    const style: CSSProperties = {
      color: color(entry.fg, entry.fg_truecolor),
      backgroundColor: color(entry.bg, entry.bg_truecolor),
      fontWeight: decorations.includes("bold") ? "bold" : undefined,
      opacity: decorations.includes("dim") ? 0.7 : undefined,
      fontStyle: decorations.includes("italic") ? "italic" : undefined,
      textDecorationLine:
        [
          decorations.includes("underline") ? "underline" : "",
          decorations.includes("strikethrough") ? "line-through" : "",
        ]
          .join(" ")
          .trim() || undefined,
    }
    return [{ text: entry.content, style }]
  })
}
