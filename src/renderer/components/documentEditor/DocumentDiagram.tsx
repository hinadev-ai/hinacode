import { useAtomValue } from "@effect/atom-react"
import { NodeViewWrapper, type ReactNodeViewProps } from "@tiptap/react"
import { AsyncResult } from "effect/reactivity"
import { useState } from "react"
import { m } from "../../paraglide/messages.js"
import { diagramAtom, useSettledDiagram } from "../../lib/diagram.ts"
import { type DiagramFailure, DiagramView } from "../MermaidDiagram.tsx"
import { Button } from "../ui/button.tsx"
import { DIAGRAM_LANGUAGE } from "./CodeLanguagePicker.tsx"
import { CodeSource } from "./CodeSource.tsx"
import { surfaceControl } from "./surfaceControl.ts"

const failedInDocument: DiagramFailure = (message) => (
  <p role="alert" className="px-4 pb-1 text-xs wrap-anywhere text-destructive">
    {m.documents_diagram_invalid({ message })}
  </p>
)

export function DiagramBlock({ node, updateAttributes }: ReactNodeViewProps) {
  const [sourceOpen, setSourceOpen] = useState(false)
  const settled = useSettledDiagram(node.textContent)
  const failed = AsyncResult.isFailure(useAtomValue(diagramAtom(settled.code, settled.uiFont)))
  const sourceShown = failed || sourceOpen
  return (
    <NodeViewWrapper data-diagram className="not-prose my-6 overflow-hidden rounded-[10px] bg-muted">
      <div contentEditable={false} data-node-control>
        <div data-print-hidden className="flex h-8 items-end justify-end px-2">
          <Button
            variant="ghost"
            size="xs"
            className={surfaceControl}
            aria-pressed={sourceShown}
            disabled={failed}
            action={() => setSourceOpen((open) => !open)}
          >
            {m.documents_chart_source()}
          </Button>
        </div>
        <DiagramView code={settled.code} uiFont={settled.uiFont} className="px-4 pb-4" failed={failedInDocument} />
      </div>
      <div hidden={!sourceShown}>
        <CodeSource language={DIAGRAM_LANGUAGE} updateAttributes={updateAttributes} />
      </div>
    </NodeViewWrapper>
  )
}
