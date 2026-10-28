import { formatForDisplay } from "@tanstack/react-hotkeys"
import { Kbd, KbdGroup } from "./ui/kbd.tsx"

const PRIMARY_MODIFIERS = new Set(["⌘", "⌃", "Ctrl", "Win", "Super"])
const SECONDARY_MODIFIERS = new Set(["⇧", "⌥", "Shift", "Alt"])

// TanStack sorts Mac modifiers the Apple way (⌃⌥⇧⌘); we read ⌘/Ctrl first, then Shift/Alt, then the key.
function rank(label: string) {
  if (PRIMARY_MODIFIERS.has(label)) return 0
  if (SECONDARY_MODIFIERS.has(label)) return 1
  return 2
}

/** A chord drawn as keycaps in the platform's notation, read out as one label. */
export function ChordKeys({ chord }: { chord: string }) {
  const keys = formatForDisplay(chord, { parts: true }).toSorted((a, b) => rank(a) - rank(b))
  return (
    <KbdGroup>
      <span className="sr-only">{formatForDisplay(chord, { useSymbols: false })}</span>
      {keys.map((label) => (
        <Kbd key={label} aria-hidden>
          {label}
        </Kbd>
      ))}
    </KbdGroup>
  )
}
