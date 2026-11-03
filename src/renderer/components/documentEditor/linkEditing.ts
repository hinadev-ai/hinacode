import { type Editor, Extension, getMarkRange } from "@tiptap/core"
import { Plugin, PluginKey } from "@tiptap/pm/state"
import { Decoration, DecorationSet } from "@tiptap/pm/view"
import { linkHref } from "../../../shared/documentLink.ts"

export type LinkRange = { readonly from: number; readonly to: number }

const linkEditKey = new PluginKey<LinkRange | null>("linkEdit")

export const openLink = (href: string | null | undefined) => {
  const target = linkHref(href ?? "")
  if (target !== null) window.open(target, "_blank", "noopener,noreferrer")
}

export const editedLink = (editor: Editor) => linkEditKey.getState(editor.state) ?? null

export const editLink = (editor: Editor, range: LinkRange | null) =>
  editor.view.dispatch(editor.state.tr.setMeta(linkEditKey, range))

const linkAt = (editor: Editor, position: number): LinkRange | null => {
  const link = editor.schema.marks["link"]
  return link === undefined ? null : (getMarkRange(editor.state.doc.resolve(position), link) ?? null)
}

export const linkOfElement = (editor: Editor, element: Element) => linkAt(editor, editor.view.posAtDOM(element, 0))

export const selectedLinkRange = (editor: Editor): LinkRange => {
  const { from, to, empty } = editor.state.selection
  return (empty ? linkAt(editor, from) : null) ?? { from, to }
}

export const hrefIn = (editor: Editor, range: LinkRange): string | null => {
  const href = editor.state.doc.nodeAt(range.from)?.marks.find((mark) => mark.type.name === "link")?.attrs["href"]
  return typeof href === "string" ? href : null
}

export const removeLink = (editor: Editor, range: LinkRange) =>
  editor
    .chain()
    .command(({ tr, state }) => {
      const link = state.schema.marks["link"]
      if (link !== undefined) tr.removeMark(range.from, range.to, link)
      return link !== undefined
    })
    .run()

export const LinkEditing = Extension.create({
  name: "linkEditing",

  addKeyboardShortcuts() {
    return {
      "Mod-k": () => {
        if (this.editor.isActive("codeBlock")) return false
        editLink(this.editor, selectedLinkRange(this.editor))
        return true
      },
    }
  },

  addProseMirrorPlugins() {
    return [
      new Plugin<LinkRange | null>({
        key: linkEditKey,
        state: {
          init: () => null,
          apply: (transaction, range) => {
            const meta: LinkRange | null | undefined = transaction.getMeta(linkEditKey)
            if (meta !== undefined) return meta
            if (range === null || !transaction.docChanged) return range
            const from = transaction.mapping.mapResult(range.from, 1)
            const to = transaction.mapping.mapResult(range.to, -1)
            return from.deleted || to.deleted || from.pos > to.pos ? null : { from: from.pos, to: to.pos }
          },
        },
        props: {
          decorations: (state) => {
            const range = linkEditKey.getState(state)
            if (range === null || range === undefined || range.from >= range.to) return null
            return DecorationSet.create(state.doc, [
              Decoration.inline(range.from, range.to, { "data-link-target": "" }),
            ])
          },
          handleClick: (_view, _position, event) => {
            if (!(event.metaKey || event.ctrlKey) || !(event.target instanceof Element)) return false
            const anchor = event.target.closest("a[href]")
            if (anchor === null) return false
            openLink(anchor.getAttribute("href"))
            return true
          },
        },
      }),
    ]
  },
})
