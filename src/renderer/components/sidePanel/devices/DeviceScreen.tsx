import { cn } from "cn"
import { type KeyboardEvent, type PointerEvent, type RefObject, useEffect, useRef } from "react"
import type { DeviceCommand, DeviceControl, DevicePlatform, DeviceScreen as Screen } from "../../../../shared/device.ts"
import { m } from "../../../paraglide/messages.js"
import { DeviceFrame } from "../../deviceFrame/DeviceFrame.tsx"
import type { DeviceSession, FrameShape } from "./deviceSession.ts"

const fraction = (value: number) => Math.min(1, Math.max(0, value))

const pointOf = (event: Pick<MouseEvent, "offsetX" | "offsetY">, canvas: HTMLCanvasElement) => ({
  x: fraction(event.offsetX / Math.max(1, canvas.offsetWidth)),
  y: fraction(event.offsetY / Math.max(1, canvas.offsetHeight)),
})

const delta = (value: number) => Math.min(10000, Math.max(-10000, value))

interface DeviceScreenProps {
  readonly canvasRef: RefObject<HTMLCanvasElement | null>
  readonly onCanvas: (canvas: HTMLCanvasElement | null) => void
  readonly sessionRef: RefObject<DeviceSession | null>
  readonly name: string
  readonly platform: DevicePlatform
  readonly screen: Screen
  readonly shape: FrameShape | null
  readonly control: DeviceControl
  readonly hardwareKeyboard: boolean
  readonly stalled: boolean
  readonly picking: boolean
  readonly hintId: string
  readonly onPick: (x: number, y: number) => void
  readonly onCancelPick: () => void
}

export function DeviceScreen({
  canvasRef,
  onCanvas,
  sessionRef,
  name,
  platform,
  screen,
  shape,
  control,
  hardwareKeyboard,
  stalled,
  picking,
  hintId,
  onPick,
  onCancelPick,
}: DeviceScreenProps) {
  const regionRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const pointerDown = useRef(false)
  const composing = useRef(false)
  const pressed = useRef(new Set<string>())
  const orientation = shape?.orientation ?? "portrait"
  const send = (command: DeviceCommand) => sessionRef.current?.command(command)

  useEffect(() => {
    if (hardwareKeyboard) inputRef.current?.focus({ preventScroll: true })
  }, [hardwareKeyboard])

  useEffect(() => {
    const region = regionRef.current
    if (!region || picking) return
    const onWheel = (event: WheelEvent) => {
      const canvas = canvasRef.current
      if (!canvas || event.target !== canvas) return
      event.preventDefault()
      event.stopPropagation()
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? canvas.clientHeight : 1
      sessionRef.current?.command({
        kind: "scroll",
        ...pointOf(event, canvas),
        deltaX: delta(event.deltaX * unit),
        deltaY: delta(event.deltaY * unit),
      })
    }
    region.addEventListener("wheel", onWheel, { passive: false })
    return () => region.removeEventListener("wheel", onWheel)
  }, [canvasRef, sessionRef, picking])

  const onPointerDown = (event: PointerEvent<HTMLCanvasElement>) => {
    if (event.button !== 0 || shape === null) return
    event.preventDefault()
    inputRef.current?.focus({ preventScroll: true })
    event.currentTarget.setPointerCapture(event.pointerId)
    pointerDown.current = true
    if (!picking) send({ kind: "touch", phase: "down", ...pointOf(event.nativeEvent, event.currentTarget) })
  }

  const onPointerMove = (event: PointerEvent<HTMLCanvasElement>) => {
    if (!pointerDown.current || picking) return
    send({ kind: "touch", phase: "move", ...pointOf(event.nativeEvent, event.currentTarget) })
  }

  const onPointerUp = (event: PointerEvent<HTMLCanvasElement>) => {
    if (!pointerDown.current) return
    pointerDown.current = false
    const point = pointOf(event.nativeEvent, event.currentTarget)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    if (picking) onPick(point.x, point.y)
    else send({ kind: "touch", phase: "up", ...point })
  }

  const onKey = (event: KeyboardEvent<HTMLInputElement>, phase: "down" | "up") => {
    event.stopPropagation()
    if (event.nativeEvent.isComposing || event.keyCode === 229 || composing.current) return
    if (event.key === "Tab") return
    if (event.key === "Escape" && picking) {
      event.preventDefault()
      if (phase === "down") onCancelPick()
      return
    }
    if (event.code === "KeyV" && (event.metaKey || event.ctrlKey)) return
    if (event.code === "" || event.code.length > 40) return
    event.preventDefault()
    if (phase === "down") pressed.current.add(event.code)
    else pressed.current.delete(event.code)
    send({ kind: "key", phase, code: event.code })
  }

  const sendText = (text: string) => {
    let chunk = ""
    for (const character of text) {
      if (chunk.length + character.length > 10000) {
        send({ kind: "text", text: chunk })
        chunk = ""
      }
      chunk += character
    }
    if (chunk) send({ kind: "text", text: chunk })
  }

  return (
    <div
      ref={regionRef}
      role="application"
      aria-label={m.devices_screen({ name })}
      aria-describedby={hintId}
      className={cn(
        "relative min-h-0 flex-1 rounded-xl outline-offset-2",
        control === "user" && "outline-2 outline-working",
        "focus-within:outline-2 focus-within:outline-ring",
      )}
    >
      <DeviceFrame
        model={platform === "ios" ? "iphone" : "pixel"}
        screen={shape?.screen ?? { width: screen.width, height: screen.height }}
        fold={shape?.posture && shape.unfolded && { posture: shape.posture, unfolded: shape.unfolded }}
        orientation={orientation}
      >
        <canvas
          ref={onCanvas}
          aria-hidden
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onContextMenu={(event) => event.preventDefault()}
          className={cn("block size-full touch-none", picking && "cursor-crosshair")}
        />
        {stalled && (
          <output className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/60 text-xs text-white">
            {m.devices_reconnecting()}
          </output>
        )}
      </DeviceFrame>
      {/* FIXME: Chromium turns off non-Latin input methods in a password field */}
      <input
        ref={inputRef}
        type={hardwareKeyboard ? "password" : "text"}
        autoComplete="off"
        data-device-keyboard
        aria-label={m.devices_input({ name })}
        aria-describedby={hintId}
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        onKeyDown={(event) => onKey(event, "down")}
        onKeyUp={(event) => onKey(event, "up")}
        onInput={(event) => {
          if (!composing.current) event.currentTarget.value = ""
        }}
        onPaste={(event) => {
          event.preventDefault()
          event.stopPropagation()
          sendText(event.clipboardData.getData("text/plain"))
        }}
        onCompositionStart={() => {
          composing.current = true
        }}
        onCompositionEnd={(event) => {
          composing.current = false
          sendText(event.data)
          event.currentTarget.value = ""
        }}
        onBlur={(event) => {
          composing.current = false
          event.currentTarget.value = ""
          for (const code of pressed.current) send({ kind: "key", phase: "up", code })
          pressed.current.clear()
        }}
        className="pointer-events-none absolute top-0 left-0 size-px overflow-hidden opacity-0"
      />
    </div>
  )
}
