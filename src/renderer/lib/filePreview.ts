import { extensionOf, previewMimeOf } from "../../shared/media.ts"

export { extensionOf } from "../../shared/media.ts"

/**
 * How the file viewer shows a file instead of its text. `svg`, `html` and `markdown` are text, so their source can
 * be shown too.
 */
export type FilePreview = "image" | "svg" | "video" | "audio" | "html" | "markdown"

const markdownExtensions = new Set(["md", "markdown"])

export const previewOf = (name: string): FilePreview | null => {
  if (markdownExtensions.has(extensionOf(name))) return "markdown"
  const mime = previewMimeOf(name)
  if (mime === undefined) return null
  if (mime === "image/svg+xml") return "svg"
  if (mime === "text/html") return "html"
  const kind = mime.slice(0, mime.indexOf("/"))
  return kind === "video" || kind === "audio" ? kind : "image"
}

export const hasSource = (preview: FilePreview) => preview === "svg" || preview === "html" || preview === "markdown"
