import { useAtomRefresh, useAtomValue } from "@effect/atom-react"
import { cn } from "cn"
import { Cause } from "effect"
import { AsyncResult } from "effect/reactivity"
import { type DragEvent, type ReactNode, useEffect, useEffectEvent, useRef, useState } from "react"
import type { VmControl } from "../../../shared/domain.ts"
import { errorMessage } from "../../lib/errorMessage.ts"
import { vmDesktopUrlAtom } from "../../lib/rpc.ts"
import { m } from "../../paraglide/messages.js"
import { Button } from "../ui/button.tsx"
import { Spinner, vmScreenId } from "./TinyVmView.tsx"
import { FullscreenExitIcon } from "../icons/FullscreenExitIcon.tsx"
import { UploadIcon } from "../icons/UploadIcon.tsx"

const carriesFiles = (event: DragEvent<HTMLElement>) => event.dataTransfer.types.includes("Files")

const onFileDragOver = (event: DragEvent<HTMLElement>) => {
  if (carriesFiles(event)) event.preventDefault()
}

interface BoatVmScreenProps {
  readonly threadId: string
  readonly sandboxId: string
  readonly control: VmControl
  readonly bare?: boolean
  readonly fullscreenControls?: ReactNode
  readonly onHandBack: () => void
  readonly onReconnect: () => void
  readonly onDropFiles: (paths: ReadonlyArray<string>) => void
  readonly dropping: boolean
}

export default function BoatVmScreen({
  threadId,
  sandboxId,
  control,
  bare = false,
  fullscreenControls,
  onHandBack,
  onReconnect,
  onDropFiles,
  dropping,
}: BoatVmScreenProps) {
  const id = vmScreenId(threadId)
  const dragDepth = useRef(0)
  const desktop = useAtomValue(vmDesktopUrlAtom(threadId, sandboxId))
  const refreshDesktop = useAtomRefresh(vmDesktopUrlAtom(threadId, sandboxId))
  const url = AsyncResult.isSuccess(desktop) ? desktop.value.url : null
  const failure = AsyncResult.isFailure(desktop) && !desktop.waiting ? errorMessage(Cause.squash(desktop.cause)) : null
  const [fullscreen, setFullscreen] = useState(false)
  const [fileDrag, setFileDrag] = useState(false)

  const handBack = useEffectEvent(() => {
    if (control === "user") onHandBack()
  })

  useEffect(
    () => () => {
      handBack()
    },
    [],
  )

  useEffect(() => {
    const onChange = () => setFullscreen(document.fullscreenElement?.id === id)
    document.addEventListener("fullscreenchange", onChange)
    return () => document.removeEventListener("fullscreenchange", onChange)
  }, [id])

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

  return (
    // oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- the section holds the desktop stream the user drives; dropping files on it copies them into the VM.
    <section
      id={id}
      aria-label={m.vm_screen()}
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
      onDragOver={onFileDragOver}
      onDrop={onDrop}
      className={cn(
        "relative aspect-video w-full overflow-hidden bg-muted [&:fullscreen]:rounded-none",
        !bare && "rounded-md",
        !bare && control === "user" && "outline-2 outline-offset-2 outline-working",
      )}
    >
      {url !== null && <webview src={url} title={m.vm_screen()} className="absolute inset-0 flex h-full w-full" />}
      {url !== null && control !== "user" && <div aria-hidden className="absolute inset-0" />}
      {fullscreen && (
        <div className="absolute top-3 right-3 z-10 flex items-center gap-2 rounded-[12px] bg-background/90 p-1 shadow-md">
          {fullscreenControls}
          <Button variant="ghost" size="xs" onClick={() => void document.exitFullscreen()}>
            <FullscreenExitIcon aria-hidden />
            {m.vm_exit_fullscreen()}
          </Button>
        </div>
      )}
      {fileDrag && (
        <div className="pointer-events-none absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 bg-background/80 p-6 text-center outline-2 -outline-offset-8 outline-dashed outline-working">
          <UploadIcon aria-hidden className="size-6" />
          <p className="text-sm">{m.vm_drop_hint()}</p>
        </div>
      )}
      {!fileDrag && dropping && (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center bg-background/60">
          <Spinner label={m.vm_drop_copying()} />
        </div>
      )}
      {url === null && failure === null && (
        <div className="absolute inset-0 flex items-center justify-center bg-muted">
          <Spinner label={m.vm_connecting()} />
        </div>
      )}
      {failure !== null && (
        <div
          role="alert"
          className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-muted p-6 text-center"
        >
          <p className="text-sm">{m.vm_desktop_failed()}</p>
          <p className="max-w-80 font-mono text-xs break-words text-muted-foreground">{failure}</p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              refreshDesktop()
              onReconnect()
            }}
          >
            {m.vm_reconnect()}
          </Button>
        </div>
      )}
    </section>
  )
}
