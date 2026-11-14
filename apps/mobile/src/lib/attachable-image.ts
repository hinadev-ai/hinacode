import { AGENT_IMAGE_MAX_BYTES } from "@shared/agentImages.ts"

export type ImageFormat = "jpeg" | "png" | "gif" | "webp"

export type ImageFit =
  | { readonly kind: "as-is"; readonly format: ImageFormat }
  | { readonly kind: "shrink"; readonly format: "jpeg" | "png" }

const bytesOf = (text: string) => [...text].map((char) => char.charCodeAt(0))

const startsWith = (head: Uint8Array, expected: readonly number[], offset = 0) =>
  expected.every((byte, index) => head[offset + index] === byte)

const imageFormatOf = (head: Uint8Array): ImageFormat | null => {
  if (startsWith(head, [0xff, 0xd8, 0xff])) return "jpeg"
  if (startsWith(head, [0x89, ...bytesOf("PNG")])) return "png"
  if (startsWith(head, bytesOf("GIF8"))) return "gif"
  if (startsWith(head, bytesOf("RIFF")) && startsWith(head, bytesOf("WEBP"), 8)) return "webp"
  return null
}

export const fitImage = (head: Uint8Array, bytes: number): ImageFit => {
  const format = imageFormatOf(head)
  if (format !== null && bytes <= AGENT_IMAGE_MAX_BYTES) return { kind: "as-is", format }
  return { kind: "shrink", format: format === "png" ? "png" : "jpeg" }
}

const extensionOf = (format: ImageFormat) => (format === "jpeg" ? "jpg" : format)

const isMediaId = (stem: string) => /^\d+$/.test(stem)

// FIXME: Android's photo picker reports a media ID such as `18` as the file name, which tells the agent nothing.
export const attachmentStem = (fileName: string | null | undefined) => {
  const stem = fileName?.replace(/\.[^.]*$/, "")
  return stem && !isMediaId(stem) ? stem : "image"
}

export const attachmentName = (fileName: string | null | undefined, format: ImageFormat) =>
  `${attachmentStem(fileName)}.${extensionOf(format)}`

export const base64Bytes = (base64: string) => (base64.length / 4) * 3 - (base64.match(/=*$/)?.[0].length ?? 0)
