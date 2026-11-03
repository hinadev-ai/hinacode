import { type Editor, Extension } from "@tiptap/core"
import { Plugin } from "@tiptap/pm/state"
import { linkHref } from "../../shared/documentLink.ts"

declare module "@tiptap/core" {
  interface Storage {
    linkEditing: { open: boolean }
  }
}

export const openLink = (href: string | null | undefined) => {
  const target = linkHref(href ?? "")
  if (target !== null) window.open(target, "_blank", "noopener,noreferrer")
}

export const setLinkEditing = (editor: Editor, open: boolean) => {
  editor.storage.linkEditing.open = open
  editor.view.dispatch(editor.state.tr.setMeta("linkEditing", open))
}

export const LinkEditing = Extension.create<object, { open: boolean }>({
  name: "linkEditing",

  addStorage: () => ({ open: false }),

  onSelectionUpdate() {
    this.storage.open = false
  },

  addKeyboardShortcuts() {
    return {
      "Mod-k": () => {
        if (this.editor.isActive("codeBlock")) return false
        setLinkEditing(this.editor, true)
        return true
      },
    }
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        props: {
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
