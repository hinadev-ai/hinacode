import { chordLabels, formatChord } from "../keybindings/chord.ts"
import { Kbd, KbdGroup } from "./ui/kbd.tsx"

/** A chord drawn as keycaps, read out as one label. */
export function ChordKeys({ chord }: { chord: string }) {
  return (
    <KbdGroup>
      <span className="sr-only">{formatChord(chord)}</span>
      {chordLabels(chord).map((label) => (
        <Kbd key={label} aria-hidden>
          {label}
        </Kbd>
      ))}
    </KbdGroup>
  )
}
