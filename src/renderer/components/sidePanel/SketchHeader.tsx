import { toast } from "sonner"
import type { Thread } from "../../../shared/domain.ts"
import { errorMessage } from "../../lib/errorMessage.ts"
import { callPromise } from "../../lib/rpc.ts"
import { m } from "../../paraglide/messages.js"
import { useDrafts } from "../../stores/drafts.ts"
import { hasDrawing, type Sketch, useSketches } from "../../stores/sketches.ts"
import { useUi } from "../../stores/ui.ts"
import { Button } from "../ui/button.tsx"

const readAsDataUrl = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.addEventListener("load", () => resolve(String(reader.result)))
    reader.addEventListener("error", () => reject(reader.error))
    reader.readAsDataURL(blob)
  })

const toPng = async ({ elements, files }: Sketch) => {
  const { exportToBlob } = await import("@excalidraw/excalidraw")
  return exportToBlob({
    elements,
    files,
    appState: { exportBackground: true, viewBackgroundColor: "#ffffff", exportWithDarkMode: false },
    exportPadding: 16,
    mimeType: "image/png",
  })
}

export function SketchHeader({ thread }: { thread: Thread }) {
  const drawn = useSketches((state) => hasDrawing(state.byThreadId[thread.id]))

  const attach = async () => {
    const sketch = useSketches.getState().byThreadId[thread.id]
    if (!hasDrawing(sketch)) return
    try {
      const dataUrl = await readAsDataUrl(await toPng(sketch))
      const staged = await callPromise("attachments.stage", {
        threadId: thread.id,
        source: { dataUrl, name: "sketch.png" },
      })
      useDrafts.getState().addAttachments(thread.id, [staged])
      useUi.getState().requestComposerFocus()
    } catch (cause) {
      toast.error(m.sketch_attach_failed({ message: errorMessage(cause) }))
    }
  }

  return (
    <div className="flex min-w-0 flex-1 items-center gap-1 pl-2">
      <h2 className="truncate text-sm font-medium">{m.panel_tab_sketch()}</h2>
      <Button
        variant="secondary"
        size="sm"
        title={m.sketch_attach_hint()}
        disabled={!drawn}
        action={attach}
        className="ms-auto"
      >
        {m.sketch_attach()}
      </Button>
    </div>
  )
}
