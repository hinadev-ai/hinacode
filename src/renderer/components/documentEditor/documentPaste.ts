import { Extension } from "@tiptap/core"
import { Plugin, PluginKey } from "@tiptap/pm/state"
import { copiedFromProseMirror, hasMarkdownStructure } from "../../lib/clipboardMarkdown.ts"

type DocumentPasteOptions = {
  readonly storeImage: (image: File) => Promise<string>
  readonly imageFailed: (cause: unknown) => void
}

const MARKDOWN_SYNTAX = /^(#{1,6} |[-*+] |\d+[.)] |> |```|\|.+\|$)|\*\*\S|`[^`\n]+`|\[[^\]\n]+\]\([^)\s]+\)/m

const imagesIn = (data: DataTransfer) => [...data.files].filter((file) => file.type.startsWith("image/"))

export const DocumentPaste = Extension.create<DocumentPasteOptions>({
  name: "documentPaste",

  addOptions() {
    return {
      storeImage: () => Promise.reject(new Error("This document cannot store images.")),
      imageFailed: () => {},
    }
  },

  addProseMirrorPlugins() {
    const { editor, options } = this

    const pasteImages = async (images: File[]) => {
      try {
        const paths = await Promise.all(images.map(options.storeImage))
        editor
          .chain()
          .focus()
          .insertContent(paths.map((src) => ({ type: "image", attrs: { src, alt: "" } })))
          .run()
      } catch (cause) {
        options.imageFailed(cause)
      }
    }

    return [
      new Plugin({
        key: new PluginKey("documentPaste"),
        props: {
          handlePaste: (_view, event) => {
            const data = event.clipboardData
            if (data === null) return false
            const images = imagesIn(data)
            if (images.length > 0) {
              void pasteImages(images)
              return true
            }
            if (editor.isActive("codeBlock") || copiedFromProseMirror(data) || hasMarkdownStructure(data)) return false
            const text = data.getData("text/plain")
            if (!MARKDOWN_SYNTAX.test(text)) return false
            return editor.commands.insertContent(text, { contentType: "markdown" })
          },
        },
      }),
    ]
  },
})
