import { chordLabels, formatChord } from "../keybindings/chord.ts"
import { Kbd, KbdGroup } from "./ui/kbd.tsx"

/** A chord drawn as keycaps, read out as one label. */
export function ChordKeys({ chord }: { chord: string }) {
  return (
    <KbdGroup aria-label={formatChord(chord)}>
      {chordLabels(chord).map((label) => (
        <Kbd key={label} aria-hidden>
          {label}
        </Kbd>
      ))}
    </KbdGroup>
  )
}
