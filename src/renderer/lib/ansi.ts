import Anser from "anser"
import type { CSSProperties } from "react"

export interface AnsiSegment {
  readonly text: string
  readonly style: CSSProperties
}

const names = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"]
const classes = [...names.map((name) => `ansi-${name}`), ...names.map((name) => `ansi-bright-${name}`)]

const color = (name: string | null, truecolor: string | null): string | undefined => {
  if (truecolor !== null) return `rgb(${truecolor})`
  const index = classes.indexOf(name ?? "")
  return index === -1 ? undefined : `var(--term-color-${index})`
}

export function ansiSegments(text: string): Array<AnsiSegment> {
  return Anser.ansiToJson(text, { use_classes: true, remove_empty: true }).flatMap((entry) => {
    const { decorations } = entry
    if (decorations.includes("hidden")) return []
    const style: CSSProperties = {
      color:
        color(entry.fg, entry.fg_truecolor) ?? (decorations.includes("dim") ? "var(--muted-foreground)" : undefined),
      backgroundColor: color(entry.bg, entry.bg_truecolor),
      fontWeight: decorations.includes("bold") ? "bold" : undefined,
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
