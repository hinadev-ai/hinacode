import type { Socket } from "node:net"
import { Effect, Schema } from "effect"

export type MouseButton = "left" | "middle" | "right"
export type ScrollDirection = "up" | "down" | "left" | "right"

/** One thing the agent does with the VM's pointer or keyboard. Coordinates are screen pixels from the top left. */
export type VmAction =
  | { readonly type: "move"; readonly x: number; readonly y: number }
  | {
      readonly type: "click"
      readonly x: number
      readonly y: number
      readonly button: MouseButton
      readonly clicks: number
    }
  | { readonly type: "drag"; readonly x: number; readonly y: number; readonly toX: number; readonly toY: number }
  | {
      readonly type: "scroll"
      readonly x: number
      readonly y: number
      readonly direction: ScrollDirection
      readonly amount: number
    }
  | { readonly type: "type"; readonly text: string }
  | { readonly type: "key"; readonly keys: string }

/** RFB message bytes to write, or a pause between them. */
export type RfbStep = Uint8Array | { readonly pauseMs: number }

export interface ScreenSize {
  readonly width: number
  readonly height: number
}

/** The action cannot be performed as given, for example a point off the screen or an unknown key name. */
export class VmInputError extends Schema.TaggedError<VmInputError>()("VmInputError", { message: Schema.String }) {}

export class RfbError extends Schema.TaggedError<RfbError>()("RfbError", { message: Schema.String }) {}

const BUTTON_MASKS: Record<MouseButton, number> = { left: 1, middle: 2, right: 4 }
const WHEEL_MASKS: Record<ScrollDirection, number> = { up: 8, down: 16, left: 32, right: 64 }
const DRAG_MOVES = 10
const DRAG_PAUSE_MS = 15

const pointerEvent = (x: number, y: number, mask: number) => {
  const bytes = Buffer.alloc(6)
  bytes[0] = 5
  bytes[1] = mask
  bytes.writeUInt16BE(x, 2)
  bytes.writeUInt16BE(y, 4)
  return bytes
}

const keyEvent = (keysym: number, down: boolean) => {
  const bytes = Buffer.alloc(8)
  bytes[0] = 4
  bytes[1] = down ? 1 : 0
  bytes.writeUInt32BE(keysym, 4)
  return bytes
}

const tap = (keysym: number) => [keyEvent(keysym, true), keyEvent(keysym, false)]

const MODIFIERS: Record<string, number> = {
  ctrl: 0xffe3,
  control: 0xffe3,
  shift: 0xffe1,
  alt: 0xffe9,
  super: 0xffeb,
  win: 0xffeb,
  cmd: 0xffeb,
  meta: 0xffeb,
}

const NAMED_KEYS: Record<string, number> = {
  return: 0xff0d,
  enter: 0xff0d,
  tab: 0xff09,
  escape: 0xff1b,
  esc: 0xff1b,
  backspace: 0xff08,
  delete: 0xffff,
  del: 0xffff,
  insert: 0xff63,
  home: 0xff50,
  end: 0xff57,
  page_up: 0xff55,
  pageup: 0xff55,
  prior: 0xff55,
  page_down: 0xff56,
  pagedown: 0xff56,
  next: 0xff56,
  left: 0xff51,
  up: 0xff52,
  right: 0xff53,
  down: 0xff54,
  space: 0x20,
  menu: 0xff67,
  print: 0xff61,
  minus: 0x2d,
  plus: 0x2b,
  equal: 0x3d,
  comma: 0x2c,
  period: 0x2e,
  slash: 0x2f,
  backslash: 0x5c,
  semicolon: 0x3b,
  apostrophe: 0x27,
  bracketleft: 0x5b,
  bracketright: 0x5d,
  grave: 0x60,
  ...Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`f${index + 1}`, 0xffbe + index])),
  ...MODIFIERS,
}

/** Latin-1 characters are their own keysym; Xvnc adds any other Unicode keysym to its keymap itself. */
const characterKeysym = (character: string) => {
  const codePoint = character.codePointAt(0)!
  return (codePoint >= 0x20 && codePoint <= 0x7e) || (codePoint >= 0xa0 && codePoint <= 0xff)
    ? codePoint
    : 0x01000000 + codePoint
}

const unknownKey = (name: string, chord: string) =>
  new VmInputError({
    message: `Unknown key "${name}" in "${chord}". Use names like Return, Tab, Escape, BackSpace, Delete, Left, Page_Down, F5 or space, or a single character, with modifiers ctrl, shift, alt or super, for example ctrl+shift+t.`,
  })

const chordSteps = (chord: string): Array<Uint8Array> => {
  // "ctrl++" and "+" name the plus key itself.
  const parts =
    chord === "+" ? ["+"] : chord.endsWith("++") ? [...chord.slice(0, -2).split("+"), "+"] : chord.split("+")
  const name = parts.at(-1)!
  const modifiers = parts.slice(0, -1).map((modifier) => {
    const keysym = MODIFIERS[modifier.toLowerCase()]
    if (keysym === undefined) throw unknownKey(modifier, chord)
    return keysym
  })
  let keysym: number | undefined
  if ([...name].length === 1) {
    // Xvnc fakes Shift to match a keysym's case, which would undo an explicit shift or add an unwanted one.
    const shifted = modifiers.includes(MODIFIERS["shift"]!)
    const letter = modifiers.length === 0 ? name : shifted ? name.toUpperCase() : name.toLowerCase()
    keysym = characterKeysym(letter)
  } else keysym = NAMED_KEYS[name.toLowerCase()]
  if (keysym === undefined) throw unknownKey(name, chord)
  return [
    ...modifiers.map((modifier) => keyEvent(modifier, true)),
    ...tap(keysym),
    ...modifiers.toReversed().map((modifier) => keyEvent(modifier, false)),
  ]
}

const textSteps = (text: string): Array<Uint8Array> =>
  [...text].flatMap((character) => {
    if (character === "\n") return tap(NAMED_KEYS["return"]!)
    if (character === "\t") return tap(NAMED_KEYS["tab"]!)
    if (character === "\r") return []
    const codePoint = character.codePointAt(0)!
    if (codePoint < 0x20 || codePoint === 0x7f) {
      throw new VmInputError({
        message: `Cannot type the control character U+${codePoint.toString(16).padStart(4, "0")}. Use vm_key for special keys.`,
      })
    }
    return tap(characterKeysym(character))
  })

const checkCoordinate = (name: string, value: number, size: number) => {
  if (!Number.isInteger(value) || value < 0 || value >= size)
    throw new VmInputError({ message: `${name} must be between 0 and ${size - 1}` })
}

const checkPoint = (screen: ScreenSize, names: readonly [string, string], x: number, y: number) => {
  checkCoordinate(names[0], x, screen.width)
  checkCoordinate(names[1], y, screen.height)
}

/**
 * The RFB messages that perform `action` on a screen of `screen` size. Throws `VmInputError` for a point
 * off the screen or a key it cannot name.
 */
export const encodeAction = (action: VmAction, screen: ScreenSize): ReadonlyArray<RfbStep> => {
  switch (action.type) {
    case "move":
      checkPoint(screen, ["x", "y"], action.x, action.y)
      return [pointerEvent(action.x, action.y, 0)]
    case "click": {
      checkPoint(screen, ["x", "y"], action.x, action.y)
      const mask = BUTTON_MASKS[action.button]
      return [
        pointerEvent(action.x, action.y, 0),
        ...Array.from({ length: action.clicks }, () => [
          pointerEvent(action.x, action.y, mask),
          pointerEvent(action.x, action.y, 0),
        ]).flat(),
      ]
    }
    case "drag": {
      checkPoint(screen, ["x", "y"], action.x, action.y)
      checkPoint(screen, ["toX", "toY"], action.toX, action.toY)
      const moves = Array.from({ length: DRAG_MOVES }, (_, index) => {
        const progress = (index + 1) / DRAG_MOVES
        return [
          { pauseMs: DRAG_PAUSE_MS },
          pointerEvent(
            Math.round(action.x + (action.toX - action.x) * progress),
            Math.round(action.y + (action.toY - action.y) * progress),
            1,
          ),
        ]
      }).flat()
      return [
        pointerEvent(action.x, action.y, 0),
        pointerEvent(action.x, action.y, 1),
        ...moves,
        pointerEvent(action.toX, action.toY, 0),
      ]
    }
    case "scroll": {
      checkPoint(screen, ["x", "y"], action.x, action.y)
      const mask = WHEEL_MASKS[action.direction]
      return [
        pointerEvent(action.x, action.y, 0),
        ...Array.from({ length: action.amount }, () => [
          pointerEvent(action.x, action.y, mask),
          pointerEvent(action.x, action.y, 0),
        ]).flat(),
      ]
    }
    case "type":
      return textSteps(action.text)
    case "key": {
      const chords = action.keys.trim().split(/\s+/).filter(Boolean)
      if (chords.length === 0)
        throw new VmInputError({ message: "keys is empty. Pass a key such as Return or ctrl+l." })
      return chords.flatMap(chordSteps)
    }
  }
}

/** Reads exact byte counts from a socket, starting with bytes that arrived before it was handed over. */
const makeReader = (socket: Socket, head: Uint8Array) => {
  let buffer = Buffer.from(head)
  let wake: (() => void) | undefined
  let ended = false
  const onData = (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk])
    wake?.()
  }
  const onEnd = () => {
    ended = true
    wake?.()
  }
  socket.on("data", onData)
  socket.on("close", onEnd)
  const read = async (length: number) => {
    while (buffer.length < length) {
      if (ended) throw new Error("the VNC server closed the connection")
      await new Promise<void>((resolve) => (wake = resolve))
    }
    const bytes = buffer.subarray(0, length)
    buffer = buffer.subarray(length)
    return bytes
  }
  const release = () => {
    socket.off("data", onData)
    socket.off("close", onEnd)
  }
  return { read, release }
}

const PROTOCOL_VERSION = "RFB 003.008\n"
const SECURITY_NONE = 1

export interface RfbConnection extends ScreenSize {
  readonly socket: Socket
}

/**
 * Performs the RFB 3.8 client handshake (no security, shared session) on a connected socket. Afterwards
 * the server sends nothing unless asked, so the caller only writes input events.
 */
export const handshake = (socket: Socket, head: Uint8Array): Effect.Effect<RfbConnection, RfbError> =>
  Effect.tryPromise({
    try: async () => {
      const reader = makeReader(socket, head)
      try {
        const version = (await reader.read(12)).toString()
        if (!version.startsWith("RFB ")) throw new Error(`unexpected greeting ${JSON.stringify(version)}`)
        socket.write(PROTOCOL_VERSION)
        const count = (await reader.read(1))[0]!
        if (count === 0) {
          const length = (await reader.read(4)).readUInt32BE(0)
          throw new Error((await reader.read(length)).toString())
        }
        const types = [...(await reader.read(count))]
        if (!types.includes(SECURITY_NONE)) throw new Error(`the server requires security types ${types.join(", ")}`)
        socket.write(Buffer.from([SECURITY_NONE]))
        if ((await reader.read(4)).readUInt32BE(0) !== 0) {
          const length = (await reader.read(4)).readUInt32BE(0)
          throw new Error((await reader.read(length)).toString())
        }
        socket.write(Buffer.from([1]))
        const init = await reader.read(24)
        await reader.read(init.readUInt32BE(20))
        return { socket, width: init.readUInt16BE(0), height: init.readUInt16BE(2) }
      } finally {
        reader.release()
        // Keeps the socket flowing so unrequested server messages (bell, clipboard) never back up.
        socket.resume()
      }
    },
    catch: (cause) =>
      new RfbError({ message: `VNC handshake failed: ${cause instanceof Error ? cause.message : String(cause)}` }),
  })

/** Writes the steps in order, pausing where they say. */
export const writeSteps = (socket: Socket, steps: ReadonlyArray<RfbStep>): Effect.Effect<void> =>
  Effect.forEach(
    steps,
    (step) => (step instanceof Uint8Array ? Effect.sync(() => void socket.write(step)) : Effect.sleep(step.pauseMs)),
    { discard: true },
  )
