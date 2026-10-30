import RFB from "@novnc/novnc"
import { matchesKeyboardEvent } from "@tanstack/react-hotkeys"
import { cn } from "cn"
import { type DragEvent, type KeyboardEvent, type ReactNode, useEffect, useEffectEvent, useRef, useState } from "react"
import { RiFullscreenExitLine, RiUpload2Line } from "react-icons/ri"
import type { VmControl } from "../../../shared/domain.ts"
import { VncChannel } from "../../lib/vncChannel.ts"
import { m } from "../../paraglide/messages.js"
import { Button } from "../ui/button.tsx"
import { HAND_BACK_CHORD, Spinner, vmScreenId } from "./TinyVmView.tsx"

type Connection = "connecting" | "connected" | "lost"

const carriesFiles = (event: DragEvent<HTMLElement>) => event.dataTransfer.types.includes("Files")

const onFileDragOver = (event: DragEvent<HTMLElement>) => {
  if (carriesFiles(event)) event.preventDefault()
}

interface TinyVmScreenProps {
  readonly threadId: string
  readonly control: VmControl
  readonly bare?: boolean
  readonly fullscreenControls?: ReactNode
  readonly onHandBack: () => void
  readonly onReconnect: () => void
  readonly onDropFiles: (paths: ReadonlyArray<string>) => void
  readonly dropping: boolean
}

export default function TinyVmScreen({
  threadId,
  control,
  bare = false,
  fullscreenControls,
  onHandBack,
  onReconnect,
  onDropFiles,
  dropping,
}: TinyVmScreenProps) {
  const id = vmScreenId(threadId)
  const targetRef = useRef<HTMLDivElement>(null)
  const rfbRef = useRef<RFB | null>(null)
  const controlRef = useRef(control)
  const dragDepth = useRef(0)
  const [connection, setConnection] = useState<Connection>("connecting")
  const [fullscreen, setFullscreen] = useState(false)
  const [fileDrag, setFileDrag] = useState(false)

  const onDragEnter = (event: DragEvent<HTMLElement>) => {
    if (!carriesFiles(event)) return
    dragDepth.current += 1
    setFileDrag(true)
  }
  const onDragLeave = (event: DragEvent<HTMLElement>) => {
    if (!carriesFiles(event)) return
    dragDepth.current -= 1
    if (dragDepth.current <= 0) {
      dragDepth.current = 0
      setFileDrag(false)
    }
  }
  const onDrop = (event: DragEvent<HTMLElement>) => {
    if (!carriesFiles(event)) return
    event.preventDefault()
    dragDepth.current = 0
    setFileDrag(false)
    const paths = [...event.dataTransfer.files].map((file) => window.hinacode.pathForFile(file))
    onDropFiles(paths.filter((path) => path !== ""))
  }

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
    if (control === "user" && controlRef.current !== "user") rfb?.focus()
    controlRef.current = control
  }, [control])

  useEffect(() => {
    const onChange = () => setFullscreen(document.fullscreenElement?.id === id)
    document.addEventListener("fullscreenchange", onChange)
    return () => document.removeEventListener("fullscreenchange", onChange)
  }, [id])

  // FIXME: noVNC takes every key while the user has control, Tab included
  const onKeyDownCapture = (event: KeyboardEvent<HTMLElement>) => {
    if (control !== "user" || !matchesKeyboardEvent(event.nativeEvent, HAND_BACK_CHORD)) return
    event.preventDefault()
    event.stopPropagation()
    onHandBack()
  }

  return (
    // oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- the section holds the noVNC canvas the user drives with mouse and keyboard; dropping files on it copies them into the VM.
    <section
      id={id}
      aria-label={m.vm_screen()}
      onKeyDownCapture={onKeyDownCapture}
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
      onDragOver={onFileDragOver}
      onDrop={onDrop}
      className={cn(
        "relative aspect-[16/10] w-full overflow-hidden bg-muted [&:fullscreen]:rounded-none",
        !bare && "rounded-md",
        !bare && control === "user" && "outline-2 outline-offset-2 outline-working",
      )}
    >
      <div ref={targetRef} className="absolute inset-0" />
      {fullscreen && (
        <div className="absolute top-3 right-3 flex items-center gap-2 rounded-[12px] bg-background/90 p-1 shadow-md">
          {fullscreenControls}
          <Button variant="ghost" size="xs" onClick={() => void document.exitFullscreen()}>
            <RiFullscreenExitLine aria-hidden />
            {m.vm_exit_fullscreen()}
          </Button>
        </div>
      )}
      {fileDrag && (
        <div className="pointer-events-none absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 bg-background/80 p-6 text-center outline-2 -outline-offset-8 outline-dashed outline-working">
          <RiUpload2Line aria-hidden className="size-6" />
          <p className="text-sm">{m.vm_drop_hint()}</p>
        </div>
      )}
      {!fileDrag && dropping && (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center bg-background/60">
          <Spinner label={m.vm_drop_copying()} />
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
