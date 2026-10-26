import { type FormEvent, type KeyboardEvent, type PointerEvent, type RefObject, useEffect, useRef } from "react"
import type { BrowserCommand } from "../../../shared/browser.ts"
import { m } from "../../paraglide/messages.js"
import type { RemoteBrowserSession } from "./remoteBrowserSession.ts"

interface SurfaceProps {
  readonly canvasRef: RefObject<HTMLCanvasElement | null>
  readonly inputRef: RefObject<HTMLTextAreaElement | null>
  readonly addressRef: RefObject<HTMLInputElement | null>
  readonly sessionRef: RefObject<RemoteBrowserSession | null>
  readonly hintId: string
  readonly picking: boolean
  readonly enabled: boolean
}

type PointerCommand = Extract<BrowserCommand, { kind: "pointer" }>
type ModifierKeys = Pick<MouseEvent, "altKey" | "ctrlKey" | "metaKey" | "shiftKey">

const modifiers = (event: ModifierKeys) =>
  (event.altKey ? 1 : 0) | (event.ctrlKey ? 2 : 0) | (event.metaKey ? 4 : 0) | (event.shiftKey ? 8 : 0)

const bounded = (value: number, maximum: number) => Math.min(maximum, Math.max(0, value))

function pointerCommand(
  canvas: HTMLCanvasElement,
  event: Pick<MouseEvent, "clientX" | "clientY" | "button" | "buttons"> & ModifierKeys,
  type: PointerCommand["type"],
  clickCount: number,
  deltaX = 0,
  deltaY = 0,
): PointerCommand {
  const rect = canvas.getBoundingClientRect()
  return {
    kind: "pointer",
    type,
    x: bounded(((event.clientX - rect.left) * canvas.width) / Math.max(1, rect.width), canvas.width - 1),
    y: bounded(((event.clientY - rect.top) * canvas.height) / Math.max(1, rect.height), canvas.height - 1),
    button:
      type === "mouseMoved" || type === "mouseWheel"
        ? "none"
        : event.button === 0
          ? "left"
          : event.button === 1
            ? "middle"
            : event.button === 2
              ? "right"
              : "none",
    buttons: event.buttons & 7,
    clickCount,
    modifiers: modifiers(event),
    deltaX: Math.min(10000, Math.max(-10000, deltaX)),
    deltaY: Math.min(10000, Math.max(-10000, deltaY)),
  }
}

export function RemoteBrowserSurface({
  canvasRef,
  inputRef,
  addressRef,
  sessionRef,
  hintId,
  picking,
  enabled,
}: SurfaceProps) {
  const composing = useRef(false)
  const committedText = useRef<string | null>(null)
  const click = useRef({ time: 0, x: 0, y: 0, button: -1, count: 0 })

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !enabled) return
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      event.stopPropagation()
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? canvas.clientHeight : 1
      sessionRef.current?.command(
        pointerCommand(canvas, event, "mouseWheel", 0, event.deltaX * unit, event.deltaY * unit),
      )
    }
    canvas.addEventListener("wheel", onWheel, { passive: false })
    return () => canvas.removeEventListener("wheel", onWheel)
  }, [canvasRef, sessionRef, enabled])

  const sendText = (text: string) => {
    let chunk = ""
    for (const character of text) {
      if (chunk.length + character.length > 10000) {
        sessionRef.current?.command({ kind: "text", text: chunk })
        chunk = ""
      }
      chunk += character
    }
    if (chunk) sessionRef.current?.command({ kind: "text", text: chunk })
  }

  const onPointerDown = (event: PointerEvent<HTMLCanvasElement>) => {
    if (!enabled) return
    event.preventDefault()
    event.stopPropagation()
    inputRef.current?.focus({ preventScroll: true })
    event.currentTarget.setPointerCapture(event.pointerId)
    const previous = click.current
    const repeated =
      event.timeStamp - previous.time < 500 &&
      Math.abs(event.clientX - previous.x) < 4 &&
      Math.abs(event.clientY - previous.y) < 4 &&
      event.button === previous.button
    const count = repeated ? (previous.count % 3) + 1 : 1
    click.current = { time: event.timeStamp, x: event.clientX, y: event.clientY, button: event.button, count }
    sessionRef.current?.command(pointerCommand(event.currentTarget, event, "mousePressed", count))
  }

  const onPointerUp = (event: PointerEvent<HTMLCanvasElement>) => {
    if (!enabled) return
    event.preventDefault()
    sessionRef.current?.command(pointerCommand(event.currentTarget, event, "mouseReleased", click.current.count))
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId)
  }

  const onKey = (event: KeyboardEvent<HTMLTextAreaElement>, type: "keyDown" | "keyUp") => {
    event.stopPropagation()
    if (
      event.nativeEvent.isComposing ||
      event.keyCode === 229 ||
      composing.current ||
      ["Process", "Dead", "Unidentified"].includes(event.key)
    ) {
      return
    }
    if (event.key === "Escape") {
      event.preventDefault()
      if (type === "keyDown") {
        if (picking) sessionRef.current?.command({ kind: "pick", enabled: false })
        else addressRef.current?.focus()
      }
      return
    }
    if (event.code === "KeyV" && (event.metaKey || event.ctrlKey)) return
    event.preventDefault()
    committedText.current = null
    const printable =
      Array.from(event.key).length === 1 &&
      ((!event.ctrlKey && !event.metaKey && !event.altKey) || event.getModifierState("AltGraph"))
    sessionRef.current?.command({
      kind: "key",
      type,
      key: event.key,
      code: event.code,
      keyCode: bounded(event.keyCode, 255),
      modifiers: modifiers(event),
      text: type === "keyDown" ? (printable ? event.key : event.key === "Enter" ? "\r" : "") : "",
    })
  }

  const onInput = (event: FormEvent<HTMLTextAreaElement>) => {
    if (composing.current || (event.nativeEvent instanceof InputEvent && event.nativeEvent.isComposing)) return
    const text = event.currentTarget.value
    event.currentTarget.value = ""
    const duplicate =
      committedText.current !== null &&
      (committedText.current === text ||
        (event.nativeEvent instanceof InputEvent && committedText.current === event.nativeEvent.data))
    committedText.current = null
    if (!duplicate) sendText(text)
  }

  return (
    <div
      role="application"
      aria-label={m.browser_remote_page()}
      aria-describedby={hintId}
      className="relative h-full w-full focus-within:outline-2 focus-within:-outline-offset-2 focus-within:outline-ring"
    >
      <canvas
        ref={canvasRef}
        aria-label={m.browser_remote_page()}
        aria-describedby={hintId}
        tabIndex={enabled ? 0 : -1}
        onFocus={() => inputRef.current?.focus({ preventScroll: true })}
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
        onPointerMove={(event) => {
          if (enabled) {
            sessionRef.current?.command(pointerCommand(event.currentTarget, event, "mouseMoved", 0))
          }
        }}
        onPointerCancel={() => sessionRef.current?.command({ kind: "release" })}
        onContextMenu={(event) => event.preventDefault()}
        className="block h-full w-full touch-none bg-white focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
      />
      <textarea
        ref={inputRef}
        aria-label={m.browser_remote_input()}
        aria-describedby={hintId}
        tabIndex={-1}
        disabled={!enabled}
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        onKeyDown={(event) => onKey(event, "keyDown")}
        onKeyUp={(event) => onKey(event, "keyUp")}
        onInput={onInput}
        onPaste={(event) => {
          event.preventDefault()
          event.stopPropagation()
          sendText(event.clipboardData.getData("text/plain"))
          event.currentTarget.value = ""
        }}
        onCompositionStart={() => {
          composing.current = true
          committedText.current = null
        }}
        onCompositionEnd={(event) => {
          composing.current = false
          committedText.current = event.data
          sendText(event.data)
          event.currentTarget.value = ""
        }}
        onBlur={(event) => {
          composing.current = false
          committedText.current = null
          event.currentTarget.value = ""
          sessionRef.current?.command({ kind: "release" })
        }}
        className="pointer-events-none absolute top-0 left-0 h-px w-px resize-none overflow-hidden opacity-0"
      />
    </div>
  )
}
