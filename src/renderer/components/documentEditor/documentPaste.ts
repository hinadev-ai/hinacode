import { Extension } from "@tiptap/core"
import { Fragment, type Node, Slice } from "@tiptap/pm/model"
import { Plugin, PluginKey } from "@tiptap/pm/state"
import { artifactUrl } from "../../../shared/channels.ts"
import { copiedFromProseMirror, hasMarkdownStructure } from "../../lib/clipboardMarkdown.ts"
import { resourceUrl } from "../../lib/resourceUrl.ts"
import { isDocumentImagePath } from "./documentImage.ts"

type DocumentPasteOptions = {
  readonly artifactId: string
  readonly storeImage: (image: File) => Promise<string>
  readonly copyImage: (sourceArtifact: string, path: string) => Promise<string>
  readonly imageFailed: (cause: unknown) => void
}

type PendingChange = { readonly add: number; readonly at: number } | { readonly remove: number }

const MARKDOWN_SYNTAX = /^(#{1,6} |[-*+] |\d+[.)] |> |```|\|.+\|$)|\*\*\S|`[^`\n]+`|\[[^\]\n]+\]\([^)\s]+\)/m

const imagesIn = (data: DataTransfer) => [...data.files].filter((file) => file.type.startsWith("image/"))

const mapImages = (fragment: Fragment, map: (image: Node) => Node): Fragment => {
  const nodes: Node[] = []
  fragment.forEach((node) => {
    if (node.type.name === "image") nodes.push(map(node))
    else if (node.isLeaf) nodes.push(node)
    else nodes.push(node.copy(mapImages(node.content, map)))
  })
  return Fragment.fromArray(nodes)
}

const pendingImages = new PluginKey<ReadonlyMap<number, number>>("documentPendingImages")

export const DocumentPaste = Extension.create<DocumentPasteOptions>({
  name: "documentPaste",

  addOptions() {
    return {
      artifactId: "",
      storeImage: () => Promise.reject(new Error("This document cannot store images.")),
      copyImage: () => Promise.reject(new Error("This document cannot store images.")),
      imageFailed: () => {},
    }
  },

  addProseMirrorPlugins() {
    const { editor, options } = this
    let nextPaste = 0
    let shiftHeld = false

    const finishPending = (id: number) => editor.view.dispatch(editor.state.tr.setMeta(pendingImages, { remove: id }))

    const pasteImages = async (images: File[]) => {
      const id = nextPaste++
      const tr = editor.state.tr.deleteSelection()
      editor.view.dispatch(tr.setMeta(pendingImages, { add: id, at: tr.selection.from }))
      try {
        const paths = await Promise.all(images.map(options.storeImage))
        const at = pendingImages.getState(editor.state)?.get(id)
        if (at === undefined) return
        editor.commands.insertContentAt(
          at,
          paths.map((src) => ({ type: "image", attrs: { src, alt: "" } })),
          { updateSelection: false },
        )
      } catch (cause) {
        options.imageFailed(cause)
      } finally {
        if (!editor.isDestroyed) finishPending(id)
      }
    }

    const copyForeignImage = async (sourceArtifact: string, path: string, shown: string) => {
      try {
        const copied = await options.copyImage(sourceArtifact, path)
        const tr = editor.state.tr
        editor.state.doc.descendants((node, pos) => {
          if (node.type.name === "image" && node.attrs["src"] === shown)
            tr.setNodeMarkup(pos, undefined, { ...node.attrs, src: copied })
        })
        if (tr.docChanged) editor.view.dispatch(tr)
      } catch (cause) {
        options.imageFailed(cause)
      }
    }

    const adoptPastedImages = (slice: Slice) =>
      new Slice(
        mapImages(slice.content, (image) => {
          const source = image.attrs["sourceArtifact"]
          const src = String(image.attrs["src"] ?? "")
          if (typeof source !== "string" || source === options.artifactId || !isDocumentImagePath(src))
            return image.type.create({ ...image.attrs, sourceArtifact: null })
          const shown = resourceUrl(artifactUrl(source, src))
          void copyForeignImage(source, src, shown)
          return image.type.create({ ...image.attrs, src: shown, sourceArtifact: null })
        }),
        slice.openStart,
        slice.openEnd,
      )

    return [
      new Plugin<ReadonlyMap<number, number>>({
        key: pendingImages,
        state: {
          init: () => new Map(),
          apply: (tr, pending) => {
            const change = tr.getMeta(pendingImages) as PendingChange | undefined
            const next = new Map([...pending].map(([id, at]) => [id, tr.mapping.map(at)]))
            if (change !== undefined && "add" in change) next.set(change.add, change.at)
            if (change !== undefined && "remove" in change) next.delete(change.remove)
            return next
          },
        },
        props: {
          handleDOMEvents: {
            keydown: (_view, event) => {
              shiftHeld = event.shiftKey
              return false
            },
            keyup: (_view, event) => {
              shiftHeld = event.shiftKey
              return false
            },
          },
          transformPasted: adoptPastedImages,
          handlePaste: (_view, event) => {
            const data = event.clipboardData
            if (data === null) return false
            const images = imagesIn(data)
            if (images.length > 0) {
              void pasteImages(images)
              return true
            }
            if (shiftHeld || editor.isActive("codeBlock")) return false
            if (copiedFromProseMirror(data) || hasMarkdownStructure(data)) return false
            const text = data.getData("text/plain")
            if (!MARKDOWN_SYNTAX.test(text)) return false
            return editor.commands.insertContent(text, { contentType: "markdown" })
          },
        },
      }),
    ]
  },
})
