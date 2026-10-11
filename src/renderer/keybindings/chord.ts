/**
 * Chords are stored in a canonical, platform-neutral form such as "mod+shift+n": lowercase,
 * modifiers first in a fixed order, then one key. "mod" is Cmd on macOS and Ctrl elsewhere.
 * Keys come from `KeyboardEvent.code`, so bindings survive keyboard layout switches.
 */

// Same detection tinykeys uses for `$mod`, so recording and matching agree.
const isMac = /Mac|iPod|iPhone|iPad/.test(navigator.platform)

const MODIFIER_KEYS = new Set(["Shift", "Control", "Alt", "Meta", "AltGraph", "CapsLock", "Fn"])

const PUNCTUATION_BY_CODE: Readonly<Record<string, string>> = {
  Comma: ",",
  Period: ".",
  Slash: "/",
  Semicolon: ";",
  Quote: "'",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Minus: "-",
  Equal: "=",
  Backquote: "`",
}
const CODE_BY_PUNCTUATION = Object.fromEntries(Object.entries(PUNCTUATION_BY_CODE).map(([code, key]) => [key, code]))

const TINYKEYS_MODIFIER: Readonly<Record<string, string>> = {
  mod: "$mod",
  ctrl: "Control",
  meta: "Meta",
  alt: "Alt",
  shift: "Shift",
}

const keyFromEvent = ({ code, key }: KeyboardEvent) => {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase()
  if (/^Digit\d$/.test(code)) return code.slice(5)
  if (code === "") return key.toLowerCase()
  return PUNCTUATION_BY_CODE[code] ?? code.toLowerCase()
}

/** The canonical chord for a keydown, or null while only modifiers are held. */
export function chordFromEvent(event: KeyboardEvent): string | null {
  if (MODIFIER_KEYS.has(event.key)) return null
  const parts: Array<string> = []
  if (isMac ? event.metaKey : event.ctrlKey) parts.push("mod")
  if (isMac && event.ctrlKey) parts.push("ctrl")
  if (!isMac && event.metaKey) parts.push("meta")
  if (event.altKey) parts.push("alt")
  if (event.shiftKey) parts.push("shift")
  parts.push(keyFromEvent(event))
  return parts.join("+")
}

const splitChord = (chord: string) => {
  const parts = chord.split("+")
  return { modifiers: parts.slice(0, -1), key: parts.at(-1) ?? "" }
}

/** Converts "mod+shift+]" to the tinykeys form "$mod+Shift+BracketRight". */
export function toTinykeys(chord: string): string {
  const { modifiers, key } = splitChord(chord)
  const tinyKey = /^[a-z]$/.test(key)
    ? `Key${key.toUpperCase()}`
    : /^\d$/.test(key)
      ? `Digit${key}`
      : (CODE_BY_PUNCTUATION[key] ?? `(${key})`) // tinykeys matches "(…)" case-insensitively against key and code
  return [...modifiers.map((modifier) => TINYKEYS_MODIFIER[modifier] ?? modifier), tinyKey].join("+")
}

const MAC_SYMBOL: Readonly<Record<string, string>> = { mod: "⌘", ctrl: "⌃", meta: "⌘", alt: "⌥", shift: "⇧" }
const PC_LABEL: Readonly<Record<string, string>> = {
  mod: "Ctrl",
  ctrl: "Ctrl",
  meta: "Win",
  alt: "Alt",
  shift: "Shift",
}

/** Splits a chord into the labels to show on keycaps, such as ["Ctrl", "Shift", "N"]. */
export function chordLabels(chord: string): Array<string> {
  const { modifiers, key } = splitChord(chord)
  const keyLabel = key.length === 1 ? key.toUpperCase() : key.charAt(0).toUpperCase() + key.slice(1)
  return [...modifiers.map((modifier) => (isMac ? MAC_SYMBOL : PC_LABEL)[modifier] ?? modifier), keyLabel]
}

/** A chord as one string for tooltips and aria labels, such as "Ctrl+Shift+N" or "⌘⇧N". */
export const formatChord = (chord: string) => chordLabels(chord).join(isMac ? "" : "+")
