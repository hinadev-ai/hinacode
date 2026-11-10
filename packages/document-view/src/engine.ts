import { Editor } from "@tiptap/core"
import type { Node } from "@tiptap/pm/model"
import { EditorState, type Transaction } from "@tiptap/pm/state"
import type { DocumentMarkdown } from "../../../src/shared/document/parse.ts"
import { createDocumentMarkdown, documentExtensions, documentMarkdown } from "../../../src/shared/document/schema.ts"

export type StructuralKey = "Enter" | "Backspace" | "Delete" | "Tab"

const backwards = new Set(["backward", "left", "up"])

const keyView = (editor: Editor) => ({
  get state() {
    return editor.state
  },
  dispatch: (tr: Transaction) => editor.view.dispatch(tr),
  endOfTextblock: (direction: string, state: EditorState = editor.state) => {
    const { $head, empty } = state.selection
    if (!empty) return false
    return backwards.has(direction) ? $head.parentOffset === 0 : $head.parentOffset === $head.parent.content.size
  },
  composing: false,
  editable: true,
  hasFocus: () => true,
})

const keyEvent = (key: StructuralKey, shiftKey: boolean) => ({
  type: "keydown",
  key,
  code: key,
  keyCode: 0,
  shiftKey,
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  preventDefault: () => {},
  stopPropagation: () => {},
})

export function createDocumentEngine() {
  const editor = new Editor({
    element: null,
    extensions: [...documentExtensions(), documentMarkdown()],
    content: { type: "doc", content: [{ type: "paragraph" }] },
    enableInputRules: false,
    enablePasteRules: false,
  })
  const manager: DocumentMarkdown = { schema: editor.schema, markdown: createDocumentMarkdown().markdown }
  return {
    editor,
    manager,
    load: (doc: Node) => editor.view.updateState(EditorState.create({ doc, plugins: editor.extensionManager.plugins })),
    press: (key: StructuralKey, shift = false) => {
      const view = keyView(editor)
      const event = keyEvent(key, shift)
      return editor.state.plugins.some(
        (plugin) => plugin.props.handleKeyDown?.call(plugin, view as never, event as never) === true,
      )
    },
    dispatch: (tr: Transaction) => editor.view.dispatch(tr),
  }
}

export type DocumentEngine = ReturnType<typeof createDocumentEngine>
