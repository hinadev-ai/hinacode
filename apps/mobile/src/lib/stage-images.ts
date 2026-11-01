import { REMOTE_MAX_FRAME_BYTES } from "@shared/remote.ts"
import { type ImagePickerAsset, launchImageLibraryAsync } from "expo-image-picker"
import { call } from "@/lib/connection"
import { copy } from "@/lib/copy"
import type { DraftImage } from "@/stores/drafts"

const CALL_ENVELOPE_BYTES = 64 * 1024

export const pickImages = async (): Promise<readonly ImagePickerAsset[]> => {
  const picked = await launchImageLibraryAsync({
    mediaTypes: ["images"],
    allowsMultipleSelection: true,
    base64: true,
    quality: 0.8,
  })
  return picked.canceled ? [] : picked.assets
}

const IMAGE_SIGNATURES = [
  { mime: "image/jpeg", extension: "jpg", matches: (head: string) => head.startsWith("\xFF\xD8\xFF") },
  { mime: "image/png", extension: "png", matches: (head: string) => head.startsWith("\x89PNG") },
  { mime: "image/gif", extension: "gif", matches: (head: string) => head.startsWith("GIF8") },
  {
    mime: "image/webp",
    extension: "webp",
    matches: (head: string) => head.startsWith("RIFF") && head.slice(8, 12) === "WEBP",
  },
]

/**
 * The picker can re-encode an image without updating its type: iOS always returns JPEG base64, and Android turns
 * HEIC, GIF and BMP into JPEG. The bytes decide the type and the file extension, so the desktop and the agent read
 * them as what they are.
 */
const encodedImage = (base64: string, declaredMime: string | null | undefined, fileName: string | null | undefined) => {
  const head = atob(base64.slice(0, 16))
  const signature = IMAGE_SIGNATURES.find(({ matches }) => matches(head))
  const stem = fileName?.replace(/\.[^.]*$/, "") ?? "image"
  if (signature) return { mime: signature.mime, name: `${stem}.${signature.extension}` }
  return { mime: declaredMime ?? "image/jpeg", name: fileName ?? "image.jpg" }
}

/**
 * Copies a picked image to the desktop. A frame over the socket's limit makes the desktop drop the connection, and
 * the phone would resend it on every reconnect, so an image that cannot fit fails here instead.
 */
export const stageImage = async (threadId: string, asset: ImagePickerAsset): Promise<DraftImage> => {
  if (!asset.base64) {
    throw new Error(copy("mobile_composer_image_unreadable", { name: asset.fileName ?? "image" }))
  }
  const { mime, name } = encodedImage(asset.base64, asset.mimeType, asset.fileName)
  const dataUrl = `data:${mime};base64,${asset.base64}`
  if (dataUrl.length > REMOTE_MAX_FRAME_BYTES - CALL_ENVELOPE_BYTES) {
    throw new Error(copy("mobile_composer_image_too_large", { name }))
  }
  const attachment = await call("attachments.stage", { threadId, source: { dataUrl, name } })
  return { attachment, preview: asset.uri }
}
