import { copy } from "@/lib/copy"
import type { DesktopStreamProps } from "./desktop-stream.types"

export function DesktopStream({ url, onLoad }: DesktopStreamProps) {
  return (
    <iframe
      data-testid="vm-desktop"
      src={url}
      title={copy("mobile_vm_screen")}
      // oxlint-disable-next-line hinacode/no-comments
      // The boat desktop is another origin and keeps its session in storage, so it needs scripts and its own origin.
      sandbox="allow-scripts allow-same-origin allow-forms allow-pointer-lock"
      allow="clipboard-read; clipboard-write; fullscreen"
      onLoad={onLoad}
      style={{ flex: 1, width: "100%", height: "100%", border: 0, background: "#000" }}
    />
  )
}
