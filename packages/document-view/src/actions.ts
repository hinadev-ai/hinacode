import type { ChainedCommands, Editor } from "@tiptap/core"
import type { CalloutTone } from "../../../src/shared/documentCallout.ts"
import { linkHref } from "../../../src/shared/documentLink.ts"

export type DocumentAction =
  | { readonly type: "toggleBold" }
  | { readonly type: "toggleItalic" }
  | { readonly type: "toggleStrike" }
  | { readonly type: "toggleCode" }
  | { readonly type: "setLink"; readonly href: string | null }
  | { readonly type: "toggleHeading"; readonly level: 1 | 2 | 3 }
  | { readonly type: "toggleBulletList" }
  | { readonly type: "toggleOrderedList" }
  | { readonly type: "toggleTaskList" }
  | { readonly type: "toggleBlockquote" }
  | { readonly type: "toggleCallout" }
  | { readonly type: "setCalloutTone"; readonly tone: CalloutTone }
  | { readonly type: "toggleCodeBlock" }
  | { readonly type: "sinkListItem" }
  | { readonly type: "liftListItem" }
  | { readonly type: "insertTable" }
  | { readonly type: "deleteTable" }
  | { readonly type: "addRowAfter" }
  | { readonly type: "addColumnAfter" }
  | { readonly type: "deleteRow" }
  | { readonly type: "deleteColumn" }
  | { readonly type: "insertImage"; readonly src: string; readonly alt: string }
  | { readonly type: "undo" }
  | { readonly type: "redo" }

export type DocumentActionType = DocumentAction["type"]

type Definition<A extends DocumentAction> = {
  readonly chain: (chain: ChainedCommands, action: A, editor: Editor) => ChainedCommands
  readonly active?: (editor: Editor) => boolean
}

type Registry = { readonly [T in DocumentActionType]: Definition<Extract<DocumentAction, { type: T }>> }

const listItemName = (editor: Editor) => (editor.isActive("taskItem") ? "taskItem" : "listItem")

const ACTIONS: Registry = {
  toggleBold: { chain: (chain) => chain.toggleBold(), active: (editor) => editor.isActive("bold") },
  toggleItalic: { chain: (chain) => chain.toggleItalic(), active: (editor) => editor.isActive("italic") },
  toggleStrike: { chain: (chain) => chain.toggleStrike(), active: (editor) => editor.isActive("strike") },
  toggleCode: { chain: (chain) => chain.toggleCode(), active: (editor) => editor.isActive("code") },
  setLink: {
    chain: (chain, { href }) => {
      const target = href === null ? null : linkHref(href)
      return target === null
        ? chain.extendMarkRange("link").unsetLink()
        : chain.extendMarkRange("link").setLink({ href: target })
    },
    active: (editor) => editor.isActive("link"),
  },
  toggleHeading: { chain: (chain, { level }) => chain.toggleHeading({ level }) },
  toggleBulletList: { chain: (chain) => chain.toggleBulletList(), active: (editor) => editor.isActive("bulletList") },
  toggleOrderedList: {
    chain: (chain) => chain.toggleOrderedList(),
    active: (editor) => editor.isActive("orderedList"),
  },
  toggleTaskList: { chain: (chain) => chain.toggleTaskList(), active: (editor) => editor.isActive("taskList") },
  toggleBlockquote: { chain: (chain) => chain.toggleBlockquote(), active: (editor) => editor.isActive("blockquote") },
  toggleCallout: {
    chain: (chain) => chain.toggleWrap("callout", { tone: "note" }),
    active: (editor) => editor.isActive("callout"),
  },
  setCalloutTone: { chain: (chain, { tone }) => chain.updateAttributes("callout", { tone }) },
  toggleCodeBlock: { chain: (chain) => chain.toggleCodeBlock(), active: (editor) => editor.isActive("codeBlock") },
  sinkListItem: { chain: (chain, _, editor) => chain.sinkListItem(listItemName(editor)) },
  liftListItem: { chain: (chain, _, editor) => chain.liftListItem(listItemName(editor)) },
  insertTable: { chain: (chain) => chain.insertTable({ rows: 3, cols: 3, withHeaderRow: true }) },
  deleteTable: { chain: (chain) => chain.deleteTable() },
  addRowAfter: { chain: (chain) => chain.addRowAfter() },
  addColumnAfter: { chain: (chain) => chain.addColumnAfter() },
  deleteRow: { chain: (chain) => chain.deleteRow() },
  deleteColumn: { chain: (chain) => chain.deleteColumn() },
  insertImage: { chain: (chain, { src, alt }) => chain.setImage({ src, alt }) },
  undo: { chain: (chain) => chain.undo() },
  redo: { chain: (chain) => chain.redo() },
}

export const ACTION_TYPES = Object.keys(ACTIONS) as ReadonlyArray<DocumentActionType>

const definitionOf = <A extends DocumentAction>(action: A) => ACTIONS[action.type] as unknown as Definition<A>

export const runAction = (editor: Editor, action: DocumentAction) =>
  definitionOf(action).chain(editor.chain(), action, editor).run()

const PROBES: { readonly [T in DocumentActionType]: Extract<DocumentAction, { type: T }> } = {
  toggleBold: { type: "toggleBold" },
  toggleItalic: { type: "toggleItalic" },
  toggleStrike: { type: "toggleStrike" },
  toggleCode: { type: "toggleCode" },
  setLink: { type: "setLink", href: "https://example.com" },
  toggleHeading: { type: "toggleHeading", level: 1 },
  toggleBulletList: { type: "toggleBulletList" },
  toggleOrderedList: { type: "toggleOrderedList" },
  toggleTaskList: { type: "toggleTaskList" },
  toggleBlockquote: { type: "toggleBlockquote" },
  toggleCallout: { type: "toggleCallout" },
  setCalloutTone: { type: "setCalloutTone", tone: "note" },
  toggleCodeBlock: { type: "toggleCodeBlock" },
  sinkListItem: { type: "sinkListItem" },
  liftListItem: { type: "liftListItem" },
  insertTable: { type: "insertTable" },
  deleteTable: { type: "deleteTable" },
  addRowAfter: { type: "addRowAfter" },
  addColumnAfter: { type: "addColumnAfter" },
  deleteRow: { type: "deleteRow" },
  deleteColumn: { type: "deleteColumn" },
  insertImage: { type: "insertImage", src: "images/probe.png", alt: "" },
  undo: { type: "undo" },
  redo: { type: "redo" },
}

export type SelectionState = {
  readonly active: ReadonlyArray<DocumentActionType>
  readonly available: ReadonlyArray<DocumentActionType>
  readonly heading: 1 | 2 | 3 | 4 | 5 | 6 | null
  readonly href: string | null
  readonly empty: boolean
}

export function selectionState(editor: Editor): SelectionState {
  const heading = editor.getAttributes("heading")["level"]
  const href = editor.getAttributes("link")["href"]
  return {
    active: ACTION_TYPES.filter((type) => ACTIONS[type].active?.(editor) === true),
    available: ACTION_TYPES.filter((type) => {
      const probe = PROBES[type]
      return definitionOf(probe).chain(editor.can().chain(), probe, editor).run()
    }),
    heading:
      typeof heading === "number" && heading >= 1 && heading <= 6 ? (heading as SelectionState["heading"]) : null,
    href: typeof href === "string" ? href : null,
    empty: editor.state.selection.empty,
  }
}
