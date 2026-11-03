import { CodeBlock } from "@tiptap/extension-code-block"
import { NodeViewContent, NodeViewWrapper, ReactNodeViewRenderer, type ReactNodeViewProps } from "@tiptap/react"
import { CHART_LANGUAGE, CodeLanguagePicker } from "./CodeLanguagePicker.tsx"
import { ChartBlock } from "./DocumentChart.tsx"

export const languageOf = (attributes: Record<string, unknown>) =>
  typeof attributes["language"] === "string" ? attributes["language"] : ""

const insideControl = (event: Event) =>
  event.target instanceof Element && event.target.closest("[data-node-control]") !== null

export const DocumentCodeBlock = CodeBlock.extend({
  addNodeView() {
    return ReactNodeViewRenderer(CodeBlockView, { stopEvent: ({ event }) => insideControl(event) })
  },
})

function CodeBlockView(props: ReactNodeViewProps) {
  const language = languageOf(props.node.attrs)
  if (language === CHART_LANGUAGE) return <ChartBlock {...props} />
  return (
    <NodeViewWrapper className="relative">
      <pre spellCheck={false}>
        <NodeViewContent<"code"> as="code" className={language === "" ? undefined : `language-${language}`} />
      </pre>
      <div contentEditable={false} data-node-control data-print-hidden className="absolute top-1.5 right-1.5">
        <CodeLanguagePicker language={language} onChange={(next) => props.updateAttributes({ language: next })} />
      </div>
    </NodeViewWrapper>
  )
}
