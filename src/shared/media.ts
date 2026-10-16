const previewMimes: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  bmp: "image/bmp",
  ico: "image/x-icon",
  svg: "image/svg+xml",
  mp4: "video/mp4",
  m4v: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  wav: "audio/wav",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  flac: "audio/flac",
  aac: "audio/aac",
  html: "text/html",
  htm: "text/html",
}

const assetMimes: Readonly<Record<string, string>> = {
  css: "text/css",
  js: "text/javascript",
  mjs: "text/javascript",
  json: "application/json",
  txt: "text/plain",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
}

export const extensionOf = (name: string) => name.slice(name.lastIndexOf(".") + 1).toLowerCase()

export const previewMimeOf = (name: string): string | undefined => previewMimes[extensionOf(name)]

export const mimeOf = (name: string): string =>
  previewMimeOf(name) ?? assetMimes[extensionOf(name)] ?? "application/octet-stream"
