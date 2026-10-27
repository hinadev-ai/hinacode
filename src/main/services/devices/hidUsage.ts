const letters = Object.fromEntries(
  Array.from({ length: 26 }, (_, index) => [`Key${String.fromCharCode(65 + index)}`, 0x04 + index]),
)
const digits = Object.fromEntries(
  Array.from({ length: 9 }, (_, index) => [`Digit${index + 1}`, 0x1e + index]).concat([["Digit0", 0x27]]),
)

/** DOM `KeyboardEvent.code` to its HID Keyboard page (0x07) usage. Codes name physical keys, as HID usages do. */
const usages: ReadonlyMap<string, number> = new Map(
  Object.entries({
    ...letters,
    ...digits,
    Enter: 0x28,
    Escape: 0x29,
    Backspace: 0x2a,
    Tab: 0x2b,
    Space: 0x2c,
    Minus: 0x2d,
    Equal: 0x2e,
    BracketLeft: 0x2f,
    BracketRight: 0x30,
    Backslash: 0x31,
    Semicolon: 0x33,
    Quote: 0x34,
    Backquote: 0x35,
    Comma: 0x36,
    Period: 0x37,
    Slash: 0x38,
    CapsLock: 0x39,
    Delete: 0x4c,
    Home: 0x4a,
    End: 0x4d,
    PageUp: 0x4b,
    PageDown: 0x4e,
    ArrowRight: 0x4f,
    ArrowLeft: 0x50,
    ArrowDown: 0x51,
    ArrowUp: 0x52,
    ControlLeft: 0xe0,
    ShiftLeft: 0xe1,
    AltLeft: 0xe2,
    MetaLeft: 0xe3,
    ControlRight: 0xe4,
    ShiftRight: 0xe5,
    AltRight: 0xe6,
    MetaRight: 0xe7,
  }),
)

export const hidUsage = (code: string): number | undefined => usages.get(code)

export interface Keystroke {
  readonly usage: number
  readonly shift: boolean
}

/** Each printable key of a US layout: its code, the character it types, and the one it types with Shift. */
const printableKeys: ReadonlyArray<readonly [code: string, plain: string, shifted: string]> = [
  ...Array.from({ length: 26 }, (_, index) => {
    const letter = String.fromCharCode(97 + index)
    return [`Key${letter.toUpperCase()}`, letter, letter.toUpperCase()] as const
  }),
  ..."1234567890".split("").map((digit, index) => [`Digit${digit}`, digit, "!@#$%^&*()"[index]!] as const),
  ["Backquote", "`", "~"],
  ["Minus", "-", "_"],
  ["Equal", "=", "+"],
  ["BracketLeft", "[", "{"],
  ["BracketRight", "]", "}"],
  ["Backslash", "\\", "|"],
  ["Semicolon", ";", ":"],
  ["Quote", "'", '"'],
  ["Comma", ",", "<"],
  ["Period", ".", ">"],
  ["Slash", "/", "?"],
]

const keystrokes: ReadonlyMap<string, Keystroke> = new Map<string, Keystroke>([
  [" ", { usage: 0x2c, shift: false }],
  ["\n", { usage: 0x28, shift: false }],
  ["\t", { usage: 0x2b, shift: false }],
  ...printableKeys.flatMap(([code, plain, shifted]) => {
    const usage = usages.get(code)!
    return [
      [plain, { usage, shift: false }],
      [shifted, { usage, shift: true }],
    ] satisfies Array<[string, Keystroke]>
  }),
])

/** The keys that type `text` on a US layout, or undefined when a character has no key. */
export const keystrokesFor = (text: string): ReadonlyArray<Keystroke> | undefined => {
  const strokes: Array<Keystroke> = []
  for (const character of text) {
    const stroke = keystrokes.get(character)
    if (!stroke) return undefined
    strokes.push(stroke)
  }
  return strokes
}
