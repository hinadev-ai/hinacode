import { Excalidraw } from "@excalidraw/excalidraw"
import "@excalidraw/excalidraw/index.css"
import { useState } from "react"
import type { Thread } from "../../../shared/domain.ts"
import { useTheme } from "../../lib/appearance.ts"
import { useClientSettings } from "../../lib/settings.ts"
import { getLocale } from "../../paraglide/runtime.js"
import { useSketches } from "../../stores/sketches.ts"

declare global {
  interface Window {
    EXCALIDRAW_ASSET_PATH?: string
  }
}

window.EXCALIDRAW_ASSET_PATH = new URL("excalidraw/", document.baseURI).href

const excalidrawLocale = { en: "en", "zh-TW": "zh-TW", "zh-CN": "zh-CN", ja: "ja-JP" } as const

const canvasActions = {
  loadScene: false,
  saveToActiveFile: false,
  export: false,
  saveAsImage: false,
  toggleTheme: false,
} as const

export function SketchView({ thread }: { thread: Thread }) {
  return <SketchCanvas key={thread.id} threadId={thread.id} />
}

function SketchCanvas({ threadId }: { threadId: string }) {
  const { scheme } = useTheme(useClientSettings().appearance.theme)
  const [initial] = useState(() => useSketches.getState().byThreadId[threadId])
  return (
    <div className="min-h-0 flex-1">
      <Excalidraw
        initialData={{ elements: initial?.elements, files: initial?.files, scrollToContent: true }}
        onChange={(elements, _appState, files) => useSketches.getState().save(threadId, { elements, files })}
        theme={scheme}
        langCode={excalidrawLocale[getLocale()]}
        UIOptions={{ canvasActions }}
      />
    </div>
  )
}
