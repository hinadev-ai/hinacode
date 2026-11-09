import { resolve } from "node:path"
import type { Plugin } from "vite"

const MERMAID_UNAVAILABLE = resolve(import.meta.dirname, "src/renderer/components/whiteboard/mermaidUnavailable.ts")

export const withoutExcalidrawMermaid = (): Plugin => ({
  name: "hinacode-without-excalidraw-mermaid",
  enforce: "pre",
  resolveId: (source) => (source === "@excalidraw/mermaid-to-excalidraw" ? MERMAID_UNAVAILABLE : null),
})
