import { TextSelection } from "@tiptap/pm/state"
import { expect, test } from "vitest"
import { parseDocument } from "../../../src/shared/document/parse.ts"
import { runAction, selectionState } from "./actions.ts"
import { createDocumentEngine } from "./engine.ts"

const editorAt = (markdown: string, text: string, length = 0) => {
  const engine = createDocumentEngine()
  engine.load(parseDocument(markdown, engine.manager).doc)
  let at = -1
  engine.editor.state.doc.descendants((node, pos) => {
    if (at === -1 && node.isText && node.text!.includes(text)) at = pos + node.text!.indexOf(text)
    return at === -1
  })
  engine.dispatch(engine.editor.state.tr.setSelection(TextSelection.create(engine.editor.state.doc, at, at + length)))
  return engine.editor
}

test("the selection state names the active marks and block, and offers table actions only in a table", () => {
  const inBold = selectionState(editorAt("## Some **bold** text", "bold", 2))
  expect(inBold.active).toContain("toggleBold")
  expect(inBold.heading).toBe(2)
  expect(inBold.available).not.toContain("addRowAfter")
  const inTable = selectionState(editorAt("| a | b |\n| --- | --- |\n| one | two |", "one"))
  expect(inTable.available).toEqual(
    expect.arrayContaining(["addRowAfter", "addColumnAfter", "deleteRow", "deleteTable"]),
  )
  expect(inTable.heading).toBeNull()
})

test("a link is set only for a web address, and an empty one removes it", () => {
  const editor = editorAt("Read the docs now", "docs", 4)
  expect(runAction(editor, { type: "setLink", href: "javascript:alert(1)" })).toBe(true)
  expect(selectionState(editor).href).toBeNull()
  runAction(editor, { type: "setLink", href: "example.com/guide" })
  expect(selectionState(editor)).toMatchObject({ href: "https://example.com/guide" })
  expect(selectionState(editor).active).toContain("setLink")
  runAction(editor, { type: "setLink", href: null })
  expect(selectionState(editor).href).toBeNull()
})

test("a callout's tone changes in place", () => {
  const editor = editorAt("> [!NOTE]\n> Careful here", "Careful")
  expect(runAction(editor, { type: "setCalloutTone", tone: "warning" })).toBe(true)
  expect(editor.getMarkdown().trimEnd()).toBe("> [!WARNING]\n> Careful here")
})
