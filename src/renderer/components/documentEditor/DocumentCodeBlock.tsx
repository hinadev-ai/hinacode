import { CodeBlock } from "@tiptap/extension-code-block"
import { NodeViewWrapper, ReactNodeViewRenderer, type ReactNodeViewProps } from "@tiptap/react"
import { CHART_LANGUAGE } from "./CodeLanguagePicker.tsx"
import { CodeSource } from "./CodeSource.tsx"
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
    <NodeViewWrapper data-code-block>
      <CodeSource language={language} updateAttributes={props.updateAttributes} />
    </NodeViewWrapper>
  )
}
