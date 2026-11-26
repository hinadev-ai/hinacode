import { useEffect, useEffectEvent, useImperativeHandle, useRef } from "react"
import { copy } from "@/lib/copy"
import type { ScreenMessage } from "@/vm-screen/controller"
import { VM_SCREEN_HTML } from "@/vm-screen/vm-screen-page"
import type { VmScreenViewProps } from "./vm-screen-view"

export type { VmScreenViewHandle } from "./vm-screen-view"

export function VmScreenView({ ref, onMessage }: VmScreenViewProps) {
  const frame = useRef<HTMLIFrameElement>(null)
  const received = useEffectEvent(onMessage)

  useImperativeHandle(ref, () => ({
    run: (command) => frame.current?.contentWindow?.postMessage({ kkScreen: command }, "*"),
  }))

  useEffect(() => {
    const listen = (event: MessageEvent<{ kkScreen?: ScreenMessage }>) => {
      if (event.source !== frame.current?.contentWindow || event.data.kkScreen === undefined) return
      received(event.data.kkScreen)
    }
    window.addEventListener("message", listen)
    return () => window.removeEventListener("message", listen)
  }, [])

  return (
    <iframe
      ref={frame}
      data-testid="vm-screen"
      title={copy("vm_screen")}
      srcDoc={VM_SCREEN_HTML}
      sandbox="allow-scripts"
      style={{ flex: 1, width: "100%", height: "100%", border: 0, backgroundColor: "transparent" }}
    />
  )
}
