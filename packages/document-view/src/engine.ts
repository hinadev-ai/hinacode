import { Editor } from "@tiptap/core"
import { Fragment, type Node, Slice } from "@tiptap/pm/model"
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

const plainTextSlice = (state: EditorState, text: string) => {
  const { $from } = state.selection
  const { schema } = state
  if ($from.parent.type.spec.code) return new Slice(Fragment.from(schema.text(text.replace(/\r\n?/g, "\n"))), 0, 0)
  const marks = $from.marks()
  const paragraphs = text
    .split(/(?:\r\n?|\n)+/)
    .map((line) => schema.nodes["paragraph"]!.create(null, line === "" ? null : schema.text(line, marks)))
  return Slice.maxOpen(Fragment.from(paragraphs), true)
}

const pasteEvent = (text: string) => ({
  type: "paste",
  clipboardData: { getData: (type: string) => (type === "text/plain" || type === "Text" ? text : ""), files: [] },
  preventDefault: () => {},
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

// FIXME: @tiptap/core's isiOS calls navigator.userAgent.includes, and React Native's navigator has no userAgent.
const giveNavigatorAUserAgent = () => {
  const host = globalThis as { navigator?: { userAgent?: unknown } }
  host.navigator ??= {}
  if (typeof host.navigator.userAgent !== "string") host.navigator.userAgent = ""
}

export function createDocumentEngine() {
  giveNavigatorAUserAgent()
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
    paste: (text: string) => {
      const view = keyView(editor)
      const slice = plainTextSlice(editor.state, text)
      const event = pasteEvent(text)
      const handled = editor.state.plugins.some(
        (plugin) => plugin.props.handlePaste?.call(plugin, view as never, event as never, slice) === true,
      )
      if (!handled) editor.view.dispatch(editor.state.tr.replaceSelection(slice).setMeta("paste", true))
    },
    dispatch: (tr: Transaction) => editor.view.dispatch(tr),
  }
}

export type DocumentEngine = ReturnType<typeof createDocumentEngine>
