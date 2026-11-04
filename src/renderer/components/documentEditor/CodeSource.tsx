import { NodeViewContent, type ReactNodeViewProps } from "@tiptap/react"
import { CodeLanguagePicker } from "./CodeLanguagePicker.tsx"

export function CodeSource({
  language,
  updateAttributes,
}: {
  language: string
  updateAttributes: ReactNodeViewProps["updateAttributes"]
}) {
  return (
    <div data-code-source>
      <div contentEditable={false} data-node-control data-print-hidden className="flex h-8 items-end px-2">
        <CodeLanguagePicker language={language} onChange={(next) => updateAttributes({ language: next })} />
      </div>
      <pre spellCheck={false}>
        <NodeViewContent<"code"> as="code" className={language === "" ? undefined : `language-${language}`} />
      </pre>
    </div>
  )
}
