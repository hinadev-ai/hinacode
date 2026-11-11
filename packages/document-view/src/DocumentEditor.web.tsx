import { type Ref, useImperativeHandle } from "react"
import { ScrollView, Text } from "react-native"
import { parseDocument, serializeDocument } from "../../../src/shared/document/parse.ts"
import type { DocumentEditorHandle, DocumentEditorProps } from "./types.ts"

export function DocumentEditor({
  ref,
  document,
  theme,
  style,
  testID,
}: DocumentEditorProps & { readonly ref?: Ref<DocumentEditorHandle> }) {
  const { doc } = parseDocument(document.markdown)
  const paragraphs: string[] = []
  doc.descendants((node) => {
    if (!node.isTextblock) return true
    paragraphs.push(node.textContent)
    return false
  })
  useImperativeHandle(ref, () => ({
    getMarkdown: () => serializeDocument(doc),
    scrollTo: async () => ({ ok: false, reason: "not-loaded" }),
    run: async () => ({ ok: false, reason: "unsupported" }),
  }))
  return (
    <ScrollView style={style} testID={testID}>
      {paragraphs.map((text, index) => (
        <Text key={index} style={{ color: theme.text, fontSize: theme.fontSize, marginBottom: 12 }}>
          {text}
        </Text>
      ))}
    </ScrollView>
  )
}
