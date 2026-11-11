import { mergeAttributes } from "@tiptap/core"
import { Image, type ImageOptions } from "@tiptap/extension-image"
import type { Node } from "@tiptap/pm/model"
import { artifactUrl } from "../../../shared/channels.ts"
import { resourceUrl } from "../../lib/resourceUrl.ts"
import { isDocumentImagePath } from "../../../shared/document/schema.ts"

export { isDocumentImagePath }

type DocumentImageOptions = ImageOptions & { readonly artifactId: string }

export const DocumentImage = Image.extend<DocumentImageOptions>({
  addOptions() {
    return { ...this.parent!(), artifactId: "" }
  },

  renderHTML({ HTMLAttributes }) {
    const stored = isDocumentImagePath(String(HTMLAttributes["src"] ?? ""))
    return [
      "img",
      mergeAttributes(
        this.options.HTMLAttributes,
        HTMLAttributes,
        stored ? { "data-artifact-id": this.options.artifactId } : {},
      ),
    ]
  },

  addNodeView() {
    const { artifactId } = this.options
    return ({ node }) => {
      const image = document.createElement("img")
      const show = (shown: Node) => {
        const src = String(shown.attrs["src"] ?? "")
        const stored = isDocumentImagePath(src)
        image.src = stored ? resourceUrl(artifactUrl(artifactId, src)) : src
        image.toggleAttribute("data-document-image", stored)
        image.dataset["path"] = stored ? src : ""
        image.alt = String(shown.attrs["alt"] ?? "")
        if (shown.attrs["title"]) image.title = String(shown.attrs["title"])
        else image.removeAttribute("title")
      }
      show(node)
      return {
        dom: image,
        update: (next) => {
          if (next.type !== node.type) return false
          show(next)
          return true
        },
      }
    }
  },
})
