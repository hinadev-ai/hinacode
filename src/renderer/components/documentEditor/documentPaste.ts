import { Extension, type Range } from "@tiptap/core"
import { Plugin, PluginKey } from "@tiptap/pm/state"
import { copiedFromProseMirror, hasMarkdownStructure } from "../../lib/clipboardMarkdown.ts"
import { isDocumentImagePath } from "./documentImage.ts"

type DocumentPasteOptions = {
  readonly artifactId: string
  readonly storeImage: (image: File) => Promise<string>
  readonly copyImage: (sourceArtifact: string, path: string) => Promise<string>
  readonly imageFailed: (cause: unknown) => void
}

type PendingChange = { readonly add: number; readonly range: Range } | { readonly remove: number }

const MARKDOWN_SYNTAX = /^(#{1,6} |[-*+] |\d+[.)] |> |```|\|.+\|$)|\*\*\S|`[^`\n]+`|\[[^\]\n]+\]\([^)\s]+\)/m

const imagesIn = (data: DataTransfer) => [...data.files].filter((file) => file.type.startsWith("image/"))

const foreignImagesIn = (data: DataTransfer, artifactId: string) => {
  const html = data.getData("text/html")
  if (html === "") return null
  const body = new DOMParser().parseFromString(html, "text/html").body
  const images = [...body.querySelectorAll<HTMLImageElement>("img[data-artifact-id]")].filter(
    (image) => image.dataset["artifactId"] !== artifactId && isDocumentImagePath(image.getAttribute("src") ?? ""),
  )
  return images.length === 0 ? null : { body, images }
}

const pendingPastes = new PluginKey<ReadonlyMap<number, Range>>("documentPendingPastes")

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

    const track = (change: PendingChange) => editor.view.dispatch(editor.state.tr.setMeta(pendingPastes, change))

    const pasteWhenReady = async (prepare: () => Promise<(range: Range) => void>) => {
      const id = nextPaste++
      const { from, to } = editor.state.selection
      track({ add: id, range: { from, to } })
      try {
        const paste = await prepare()
        const range = pendingPastes.getState(editor.state)?.get(id)
        if (range !== undefined && !editor.isDestroyed) paste(range)
      } catch (cause) {
        options.imageFailed(cause)
      } finally {
        if (!editor.isDestroyed) track({ remove: id })
      }
    }

    const pasteImages = (images: File[]) =>
      pasteWhenReady(async () => {
        const paths = await Promise.all(images.map(options.storeImage))
        return (range) =>
          editor.commands.insertContentAt(
            range,
            paths.map((src) => ({ type: "image", attrs: { src, alt: "" } })),
          )
      })

    const pasteCopyingImages = ({ body, images }: { body: HTMLElement; images: HTMLImageElement[] }) =>
      pasteWhenReady(async () => {
        await Promise.all(
          images.map(async (image) => {
            image.setAttribute("src", await options.copyImage(image.dataset["artifactId"]!, image.getAttribute("src")!))
            image.dataset["artifactId"] = options.artifactId
          }),
        )
        return (range) => {
          editor.commands.setTextSelection(range)
          editor.view.pasteHTML(body.innerHTML)
        }
      })

    return [
      new Plugin<ReadonlyMap<number, Range>>({
        key: pendingPastes,
        state: {
          init: () => new Map(),
          apply: (tr, pending) => {
            const change = tr.getMeta(pendingPastes) as PendingChange | undefined
            const next = new Map<number, Range>()
            for (const [id, { from, to }] of pending) {
              next.set(id, { from: tr.mapping.map(from, -1), to: tr.mapping.map(to, -1) })
            }
            if (change !== undefined && "add" in change) next.set(change.add, change.range)
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
          handlePaste: (_view, event) => {
            const data = event.clipboardData
            if (data === null) return false
            const images = imagesIn(data)
            if (images.length > 0) {
              void pasteImages(images)
              return true
            }
            const foreign = foreignImagesIn(data, options.artifactId)
            if (foreign !== null) {
              void pasteCopyingImages(foreign)
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
