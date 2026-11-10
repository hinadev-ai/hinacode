import { Editor } from "@tiptap/core"
import type { Node } from "@tiptap/pm/model"
import { TextSelection } from "@tiptap/pm/state"
import { expect, test } from "vitest"
import { createDocumentEngine, type StructuralKey } from "../../../../packages/document-view/src/engine.ts"
import { parseDocument } from "../../../shared/document/parse.ts"
import { documentExtensions, documentMarkdown } from "../../../shared/document/schema.ts"

type Step =
  | { readonly key: StructuralKey; readonly shift?: boolean }
  | { readonly command: (editor: Editor) => boolean }
  | { readonly type: string }

type Case = {
  readonly name: string
  readonly markdown: string
  readonly at: string
  readonly to?: string
  readonly steps: ReadonlyArray<Step>
}

const positionAfter = (doc: Node, marker: string) => {
  let found = -1
  doc.descendants((node, pos) => {
    if (found !== -1 || !node.isText) return found === -1
    const index = node.text!.indexOf(marker)
    if (index !== -1) found = pos + index + marker.length
    return false
  })
  if (found === -1) throw new Error(`no text ${marker}`)
  return found
}

const select = (editor: Editor, { at, to }: Case) => {
  const { doc } = editor.state
  const from = positionAfter(doc, at)
  const end = to === undefined ? from : positionAfter(doc, to)
  editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(doc, from, end)))
}

const onDesktop = (scenario: Case) => {
  const editor = new Editor({
    extensions: [...documentExtensions(), documentMarkdown()],
    content: scenario.markdown,
    contentType: "markdown",
    enableInputRules: false,
  })
  select(editor, scenario)
  for (const step of scenario.steps) {
    if ("key" in step) {
      const event = new KeyboardEvent("keydown", { key: step.key, shiftKey: step.shift ?? false })
      editor.view.someProp("handleKeyDown", (handle) => handle(editor.view, event))
    } else if ("command" in step) step.command(editor)
    else editor.view.dispatch(editor.state.tr.insertText(step.type))
  }
  const result = { json: editor.getJSON(), markdown: editor.getMarkdown() }
  editor.destroy()
  return result
}

const onPhone = (scenario: Case) => {
  const engine = createDocumentEngine()
  engine.load(parseDocument(scenario.markdown, engine.manager).doc)
  select(engine.editor, scenario)
  for (const step of scenario.steps) {
    if ("key" in step) engine.press(step.key, step.shift)
    else if ("command" in step) step.command(engine.editor)
    else engine.dispatch(engine.editor.state.tr.insertText(step.type))
  }
  const result = { json: engine.editor.getJSON(), markdown: engine.editor.getMarkdown() }
  engine.editor.destroy()
  return result
}

const CASES: ReadonlyArray<Case> = [
  { name: "Enter splits a paragraph", markdown: "First half second half", at: "First half", steps: [{ key: "Enter" }] },
  {
    name: "Enter at the end of a heading starts a paragraph",
    markdown: "## Title\n\nBody",
    at: "Title",
    steps: [{ key: "Enter" }, { type: "new" }],
  },
  {
    name: "Enter in a list item splits the item",
    markdown: "- one two\n- three",
    at: "one",
    steps: [{ key: "Enter" }, { type: "x" }],
  },
  {
    name: "Enter on an empty list item leaves the list",
    markdown: "- one\n- three",
    at: "three",
    steps: [{ key: "Enter" }, { key: "Enter" }, { type: "after" }],
  },
  {
    name: "Tab nests a list item and Shift-Tab lifts it back",
    markdown: "- one\n- two\n- three",
    at: "two",
    steps: [{ key: "Tab" }, { key: "Tab", shift: true }, { key: "Tab" }],
  },
  {
    name: "Enter in a task item makes an unchecked task",
    markdown: "- [x] done\n- [ ] open",
    at: "done",
    steps: [{ key: "Enter" }, { type: "next" }],
  },
  {
    name: "Enter in a code block inserts a newline",
    markdown: "```ts\nconst a = 1\n```",
    at: "const a",
    steps: [{ key: "Enter" }, { type: "b" }],
  },
  {
    name: "Enter in a callout paragraph stays in the callout",
    markdown: "> [!TIP]\n> Use it well",
    at: "Use it",
    steps: [{ key: "Enter" }, { type: "x" }],
  },
  {
    name: "Enter in a table cell keeps the table",
    markdown: "| a | b |\n| --- | --- |\n| one | two |",
    at: "one",
    steps: [{ key: "Enter" }, { type: "x" }],
  },
  {
    name: "Tab moves to the next table cell",
    markdown: "| a | b |\n| --- | --- |\n| one | two |",
    at: "one",
    steps: [{ key: "Tab" }, { type: "!" }],
  },
  {
    name: "Delete at the end of a paragraph joins the next one",
    markdown: "One\n\nTwo",
    at: "One",
    steps: [{ key: "Delete" }],
  },
  {
    name: "toggleBold over a range",
    markdown: "Some plain words here",
    at: "Some ",
    to: "plain words",
    steps: [{ command: (editor) => editor.commands.toggleBold() }],
  },
  {
    name: "toggleBold over code keeps the schema's exclusion",
    markdown: "Use `code` here",
    at: "Use ",
    to: " here",
    steps: [{ command: (editor) => editor.commands.toggleBold() }],
  },
  {
    name: "toggleTaskList turns a bullet list into tasks",
    markdown: "- one\n- two",
    at: "one",
    steps: [{ command: (editor) => editor.commands.toggleTaskList() }],
  },
  {
    name: "toggleOrderedList on a paragraph",
    markdown: "Alone",
    at: "Al",
    steps: [{ command: (editor) => editor.commands.toggleOrderedList() }],
  },
  {
    name: "setHeading and back to a paragraph",
    markdown: "Text",
    at: "Te",
    steps: [{ command: (editor) => editor.commands.setHeading({ level: 2 }) }],
  },
  {
    name: "addRowAfter and addColumnAfter in a table",
    markdown: "| a | b |\n| --- | --- |\n| one | two |",
    at: "one",
    steps: [
      { command: (editor) => editor.commands.addRowAfter() },
      { command: (editor) => editor.commands.addColumnAfter() },
    ],
  },
  {
    name: "setLink over a range, then typing after it",
    markdown: "Read the docs now",
    at: "Read the ",
    to: "docs",
    steps: [
      { command: (editor) => editor.commands.setLink({ href: "https://example.com" }) },
      { command: (editor) => editor.commands.setTextSelection(editor.state.selection.to) },
      { type: "!" },
    ],
  },
]

const changesTheDocument = (scenario: Case) =>
  expect(onPhone(scenario).json, "the steps changed nothing").not.toEqual(onPhone({ ...scenario, steps: [] }).json)

test.each(CASES)("$name gives the desktop's document", (scenario) => {
  changesTheDocument(scenario)
  changesTheDocument(scenario)
  expect(onPhone(scenario)).toEqual(onDesktop(scenario))
})

test.each([
  { name: "Backspace at the start of a paragraph", markdown: "One\n\nTwo", line: "Two" },
  { name: "Backspace at the start of a nested list item", markdown: "- one\n  - two\n- three", line: "two" },
  { name: "Backspace at the start of a task item", markdown: "- [ ] one\n- [ ] two", line: "two" },
  {
    name: "Backspace at the start of a callout's first paragraph",
    markdown: "Before\n\n> [!NOTE]\n> Inside",
    line: "Inside",
  },
  {
    name: "Backspace at the start of a list item after a nested list",
    markdown: "- one\n  - deep\n- three",
    line: "three",
  },
])("$name gives the desktop's document", ({ name, markdown, line }) => {
  const scenario: Case = {
    name,
    markdown,
    at: line,
    steps: [
      { command: (editor) => editor.commands.setTextSelection(editor.state.selection.from - line.length) },
      { key: "Backspace" },
    ],
  }
  changesTheDocument(scenario)
  expect(onPhone(scenario)).toEqual(onDesktop(scenario))
})

test("undo after typing and Enter returns to the desktop's document, and redo replays it", () => {
  const typed: Case = { name: "typed", markdown: "- one\n- two", at: "one", steps: [{ type: "x" }, { key: "Enter" }] }
  const undone: Case = {
    ...typed,
    steps: [
      ...typed.steps,
      { command: (editor) => editor.commands.undo() },
      { command: (editor) => editor.commands.undo() },
    ],
  }
  const redone: Case = { ...undone, steps: [...undone.steps, { command: (editor) => editor.commands.redo() }] }
  expect(onPhone(undone)).toEqual(onDesktop(undone))
  expect(onPhone(undone).json).toEqual(onPhone({ ...typed, steps: [] }).json)
  expect(onPhone(redone)).toEqual(onDesktop(redone))
})
