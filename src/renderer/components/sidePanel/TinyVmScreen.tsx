import RFB from "@novnc/novnc"
import { matchesKeyboardEvent } from "@tanstack/react-hotkeys"
import { cn } from "cn"
import { type KeyboardEvent, type ReactNode, useEffect, useEffectEvent, useRef, useState } from "react"
import { RiFullscreenExitLine } from "react-icons/ri"
import type { VmControl } from "../../../shared/domain.ts"
import { VncChannel } from "../../lib/vncChannel.ts"
import { m } from "../../paraglide/messages.js"
import { Button } from "../ui/button.tsx"
import { HAND_BACK_CHORD, Spinner, vmScreenId } from "./TinyVmView.tsx"

type Connection = "connecting" | "connected" | "lost"

interface TinyVmScreenProps {
  readonly threadId: string
  readonly control: VmControl
  /** Leaves the rounding and the control outline to its container, as the floating screen does. */
  readonly bare?: boolean
  /** Shown over the screen while it is full screen, where the toolbar around it is gone. */
  readonly fullscreenControls?: ReactNode
  readonly onHandBack: () => void
  readonly onReconnect: () => void
}

/**
 * The VM's desktop through noVNC, view-only unless the user has control. Remounted per sandbox and reconnect.
 * Loaded lazily: noVNC probes for an H.264 decoder in a top-level await when its module is evaluated.
 */
export default function TinyVmScreen({
  threadId,
  control,
  bare = false,
  fullscreenControls,
  onHandBack,
  onReconnect,
}: TinyVmScreenProps) {
  const id = vmScreenId(threadId)
  const targetRef = useRef<HTMLDivElement>(null)
  const rfbRef = useRef<RFB | null>(null)
  const controlRef = useRef(control)
  const [connection, setConnection] = useState<Connection>("connecting")
  const [fullscreen, setFullscreen] = useState(false)

  const applyControl = useEffectEvent((rfb: RFB) => {
    rfb.viewOnly = control !== "user"
    rfb.focusOnClick = control === "user"
  })

  useEffect(() => {
    const target = targetRef.current
    if (!target) return
    const rfb = new RFB(target, new VncChannel(threadId), { shared: true })
    rfb.scaleViewport = true
    rfb.resizeSession = false
    rfb.background = "var(--muted)"
    applyControl(rfb)
    const onConnect = () => setConnection("connected")
    const onDisconnect = () => setConnection("lost")
    rfb.addEventListener("connect", onConnect)
    rfb.addEventListener("disconnect", onDisconnect)
    rfbRef.current = rfb
    return () => {
      rfb.removeEventListener("connect", onConnect)
      rfb.removeEventListener("disconnect", onDisconnect)
      rfb.disconnect()
      rfbRef.current = null
    }
  }, [threadId])

  useEffect(() => {
    const rfb = rfbRef.current
    if (rfb) applyControl(rfb)
    // Only on the hand over itself, so opening the view never takes focus from the composer.
    if (control === "user" && controlRef.current !== "user") rfb?.focus()
    controlRef.current = control
  }, [control])

  useEffect(() => {
    const onChange = () => setFullscreen(document.fullscreenElement?.id === id)
    document.addEventListener("fullscreenchange", onChange)
    return () => document.removeEventListener("fullscreenchange", onChange)
  }, [id])

  // noVNC takes every key while the user has control, Tab included, so this chord is the keyboard's way out.
  const onKeyDownCapture = (event: KeyboardEvent<HTMLElement>) => {
    if (control !== "user" || !matchesKeyboardEvent(event.nativeEvent, HAND_BACK_CHORD)) return
    event.preventDefault()
    event.stopPropagation()
    onHandBack()
  }

  return (
    <section
      id={id}
      aria-label={m.vm_screen()}
      onKeyDownCapture={onKeyDownCapture}
      className={cn(
        "relative aspect-[16/10] w-full overflow-hidden bg-muted [&:fullscreen]:rounded-none",
        !bare && "rounded-md",
        !bare && control === "user" && "outline-2 outline-offset-2 outline-working",
      )}
    >
      <div ref={targetRef} className="absolute inset-0" />
      {fullscreen && (
        <div className="absolute top-3 right-3 flex items-center gap-2 rounded-lg bg-background/90 p-1 shadow-md">
          {fullscreenControls}
          <Button variant="ghost" size="xs" onClick={() => void document.exitFullscreen()}>
            <RiFullscreenExitLine aria-hidden />
            {m.vm_exit_fullscreen()}
          </Button>
        </div>
      )}
      {connection === "connecting" && (
        <div className="absolute inset-0 flex items-center justify-center bg-muted">
          <Spinner label={m.vm_connecting()} />
        </div>
      )}
      {connection === "lost" && (
        <div
          role="alert"
          className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-muted p-6 text-center"
        >
          <p className="text-sm">{m.vm_disconnected()}</p>
          <Button variant="outline" size="sm" onClick={onReconnect}>
            {m.vm_reconnect()}
          </Button>
        </div>
      )}
    </section>
  )
}
