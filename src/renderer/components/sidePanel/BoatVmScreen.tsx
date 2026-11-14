import { useAtomRefresh, useAtomValue } from "@effect/atom-react"
import { cn } from "cn"
import { Cause } from "effect"
import { AsyncResult } from "effect/reactivity"
import { type ReactNode, useEffect, useEffectEvent, useState } from "react"
import type { VmControl } from "../../../shared/domain.ts"
import { errorMessage, toastError } from "../../lib/errorMessage.ts"
import { vmDesktopUrlAtom } from "../../lib/rpc.ts"
import { inBrowser } from "../../lib/runtime.ts"
import { m } from "../../paraglide/messages.js"
import { Button } from "../ui/button.tsx"
import { Spinner, type VmDrop, VmDropOverlay, vmScreenId } from "./TinyVmView.tsx"
import { FullscreenExitIcon } from "@hinacode/icons"

interface BoatVmScreenProps {
  readonly threadId: string
  readonly sandboxId: string
  readonly control: VmControl
  readonly bare?: boolean
  readonly fullscreenControls?: ReactNode
  readonly onHandBack: () => void
  readonly onReconnect: () => void
  readonly drop: VmDrop
}

export default function BoatVmScreen({
  threadId,
  sandboxId,
  control,
  bare = false,
  fullscreenControls,
  onHandBack,
  onReconnect,
  drop,
}: BoatVmScreenProps) {
  const id = vmScreenId(threadId)
  const desktop = useAtomValue(vmDesktopUrlAtom(threadId, sandboxId))
  const refreshDesktop = useAtomRefresh(vmDesktopUrlAtom(threadId, sandboxId))
  const url = AsyncResult.isSuccess(desktop) ? desktop.value.url : null
  const failure = AsyncResult.isFailure(desktop) && !desktop.waiting ? errorMessage(Cause.squash(desktop.cause)) : null
  const [fullscreen, setFullscreen] = useState(false)

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

  return (
    <section
      id={id}
      aria-label={m.vm_screen()}
      {...drop.dropTarget}
      className={cn(
        "relative aspect-video w-full overflow-hidden bg-muted [&:fullscreen]:rounded-none",
        !bare && "rounded-md",
        !bare && control === "user" && "outline-2 outline-offset-2 outline-working",
      )}
    >
      {url !== null &&
        (inBrowser() ? (
          <iframe
            src={url}
            title={m.vm_screen()}
            // oxlint-disable-next-line react/iframe-missing-sandbox -- the Boat desktop is another origin and keeps its session in storage, so it needs scripts and its own origin.
            sandbox="allow-scripts allow-same-origin allow-forms allow-pointer-lock allow-downloads"
            allow="clipboard-read; clipboard-write; fullscreen"
            className="absolute inset-0 flex size-full border-0"
          />
        ) : (
          <webview src={url} title={m.vm_screen()} className="absolute inset-0 flex size-full" />
        ))}
      {url !== null && control !== "user" && <div aria-hidden className="absolute inset-0" />}
      {fullscreen && (
        <div className="absolute top-3 right-3 z-10 flex items-center gap-2 rounded-[12px] bg-background/90 p-1 shadow-md">
          {fullscreenControls}
          <Button variant="ghost" size="xs" action={() => document.exitFullscreen().catch(toastError)}>
            <FullscreenExitIcon aria-hidden />
            {m.vm_exit_fullscreen()}
          </Button>
        </div>
      )}
      <VmDropOverlay drop={drop} />
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
          <p className="max-w-80 font-mono text-xs wrap-break-word text-muted-foreground">{failure}</p>
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
