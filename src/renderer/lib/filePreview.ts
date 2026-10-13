/** How the file viewer shows a file instead of its text. `svg` and `html` are text, so their source can be shown too. */
export type FilePreview = "image" | "svg" | "video" | "audio" | "html"

const previewByExtension: Readonly<Record<string, FilePreview>> = {
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  webp: "image",
  avif: "image",
  bmp: "image",
  ico: "image",
  svg: "svg",
  mp4: "video",
  m4v: "video",
  mov: "video",
  webm: "video",
  mp3: "audio",
  m4a: "audio",
  wav: "audio",
  ogg: "audio",
  oga: "audio",
  flac: "audio",
  aac: "audio",
  html: "html",
  htm: "html",
}

export const extensionOf = (name: string) => name.slice(name.lastIndexOf(".") + 1).toLowerCase()

export const previewOf = (name: string): FilePreview | null => previewByExtension[extensionOf(name)] ?? null

export const hasSource = (preview: FilePreview) => preview === "svg" || preview === "html"
