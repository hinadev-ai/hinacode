import { previewMimeOf } from "../../shared/media.ts"

export { extensionOf } from "../../shared/media.ts"

/** How the file viewer shows a file instead of its text. `svg` and `html` are text, so their source can be shown too. */
export type FilePreview = "image" | "svg" | "video" | "audio" | "html"

export const previewOf = (name: string): FilePreview | null => {
  const mime = previewMimeOf(name)
  if (mime === undefined) return null
  if (mime === "image/svg+xml") return "svg"
  if (mime === "text/html") return "html"
  const kind = mime.slice(0, mime.indexOf("/"))
  return kind === "video" || kind === "audio" ? kind : "image"
}

export const hasSource = (preview: FilePreview) => preview === "svg" || preview === "html"
