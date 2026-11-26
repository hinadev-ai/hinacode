import type RFB from "@novnc/novnc"

export type ScreenFit = "fit" | "actual"

export type ScreenKey = "Escape" | "Tab" | "BackSpace" | "Return" | "Left" | "Up" | "Right" | "Down"

export type ScreenCommand =
  | { readonly type: "open" }
  | { readonly type: "data"; readonly data: string }
  | { readonly type: "end" }
  | { readonly type: "control"; readonly user: boolean }
  | { readonly type: "fit"; readonly fit: ScreenFit }
  | { readonly type: "text"; readonly text: string; readonly ctrl: boolean }
  | { readonly type: "key"; readonly key: ScreenKey; readonly ctrl: boolean }

export type ScreenMessage =
  | { readonly type: "ready" }
  | { readonly type: "send"; readonly data: string }
  | { readonly type: "connected" }
  | { readonly type: "disconnected" }

type RfbClass = new (...args: ConstructorParameters<typeof RFB>) => RFB

const keysyms: Record<ScreenKey, number> = {
  Escape: 0xff1b,
  Tab: 0xff09,
  BackSpace: 0xff08,
  Return: 0xff0d,
  Left: 0xff51,
  Up: 0xff52,
  Right: 0xff53,
  Down: 0xff54,
}

const CONTROL_KEYSYM = 0xffe3
const UNICODE_KEYSYM = 0x01000000

export const keysymOf = (character: string) => {
  if (character === "\n") return keysyms.Return
  if (character === "\t") return keysyms.Tab
  const codePoint = character.codePointAt(0) ?? 0
  return codePoint < 0x100 ? codePoint : UNICODE_KEYSYM + codePoint
}

const toBase64 = (bytes: Uint8Array) => {
  let binary = ""
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
  }
  return btoa(binary)
}

const fromBase64 = (text: string) => Uint8Array.from(atob(text), (character) => character.charCodeAt(0))

class PageChannel {
  binaryType = "arraybuffer"
  readonly protocol = ""
  readyState: "connecting" | "open" | "closing" | "closed" = "connecting"
  onopen: (() => void) | null = null
  onmessage: ((event: { readonly data: ArrayBuffer }) => void) | null = null
  onclose: ((event: { code: number; reason: string; wasClean: boolean }) => void) | null = null
  onerror: ((event: unknown) => void) | null = null

  readonly #post: (message: ScreenMessage) => void

  constructor(post: (message: ScreenMessage) => void) {
    this.#post = post
  }

  send(data: Uint8Array) {
    if (this.readyState === "open") this.#post({ type: "send", data: toBase64(data) })
  }

  close() {
    queueMicrotask(() => this.finish())
  }

  open() {
    if (this.readyState !== "connecting") return
    this.readyState = "open"
    this.onopen?.()
  }

  receive(data: string) {
    if (this.readyState === "open") this.onmessage?.({ data: fromBase64(data).buffer })
  }

  finish() {
    if (this.readyState === "closed") return
    this.readyState = "closed"
    this.onclose?.({ code: 1000, reason: "", wasClean: true })
  }
}

export function mountScreen(Rfb: RfbClass, target: HTMLElement, post: (message: ScreenMessage) => void) {
  const channel = new PageChannel(post)
  const rfb = new Rfb(target, channel, { shared: true })
  rfb.viewOnly = true
  rfb.focusOnClick = false
  rfb.resizeSession = false
  rfb.scaleViewport = true
  rfb.background = "transparent"
  rfb.addEventListener("connect", () => post({ type: "connected" }))
  rfb.addEventListener("disconnect", () => post({ type: "disconnected" }))

  const withControl = (ctrl: boolean, press: () => void) => {
    if (ctrl) rfb.sendKey(CONTROL_KEYSYM, "ControlLeft", true)
    press()
    if (ctrl) rfb.sendKey(CONTROL_KEYSYM, "ControlLeft", false)
  }

  const run = (command: ScreenCommand) => {
    switch (command.type) {
      case "open":
        return channel.open()
      case "data":
        return channel.receive(command.data)
      case "end":
        return channel.finish()
      case "control":
        rfb.viewOnly = !command.user
        return
      case "fit":
        rfb.scaleViewport = command.fit === "fit"
        rfb.clipViewport = command.fit === "actual"
        rfb.dragViewport = command.fit === "actual"
        return
      case "text":
        return withControl(command.ctrl, () => {
          for (const character of command.text) rfb.sendKey(keysymOf(character), null)
        })
      case "key":
        return withControl(command.ctrl, () => rfb.sendKey(keysyms[command.key], null))
    }
  }

  return { run, unmount: () => rfb.disconnect() }
}
