export type ImageFormat = "jpeg" | "png" | "gif" | "webp"

const bytesOf = (text: string) => [...text].map((char) => char.charCodeAt(0))

const startsWith = (head: Uint8Array, expected: ReadonlyArray<number>, offset = 0) =>
  expected.every((byte, index) => head[offset + index] === byte)

const imageFormatOf = (head: Uint8Array): ImageFormat | null => {
  if (startsWith(head, [0xff, 0xd8, 0xff])) return "jpeg"
  if (startsWith(head, [0x89, ...bytesOf("PNG")])) return "png"
  if (startsWith(head, bytesOf("GIF8"))) return "gif"
  if (startsWith(head, bytesOf("RIFF")) && startsWith(head, bytesOf("WEBP"), 8)) return "webp"
  return null
}

export const fitImage = (head: Uint8Array, _bytes: number) => ({ kind: "as-is", format: imageFormatOf(head) })

const extensionOf = (format: ImageFormat) => (format === "jpeg" ? "jpg" : format)

export const attachmentName = (fileName: string | null | undefined, format: ImageFormat) =>
  `${fileName?.replace(/\.[^.]*$/, "") ?? "image"}.${extensionOf(format)}`

export const base64Bytes = (base64: string) => (base64.length / 4) * 3 - (base64.match(/=*$/)?.[0].length ?? 0)
