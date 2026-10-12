import { formatForDisplay } from "@tanstack/react-hotkeys"
import { Kbd, KbdGroup } from "./ui/kbd.tsx"

/** A chord drawn as keycaps in the platform's notation, read out as one label. */
export function ChordKeys({ chord }: { chord: string }) {
  return (
    <KbdGroup>
      <span className="sr-only">{formatForDisplay(chord, { useSymbols: false })}</span>
      {formatForDisplay(chord, { parts: true }).map((label) => (
        <Kbd key={label} aria-hidden>
          {label}
        </Kbd>
      ))}
    </KbdGroup>
  )
}
