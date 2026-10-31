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

/**
 * Copies a picked image to the desktop. A frame over the socket's limit makes the desktop drop the connection, and
 * the phone would resend it on every reconnect, so an image that cannot fit fails here instead.
 */
export const stageImage = async (threadId: string, asset: ImagePickerAsset): Promise<DraftImage> => {
  const name = asset.fileName ?? "image.jpg"
  if (!asset.base64) throw new Error(copy("mobile_composer_image_unreadable", { name }))
  const dataUrl = `data:${asset.mimeType ?? "image/jpeg"};base64,${asset.base64}`
  if (dataUrl.length > REMOTE_MAX_FRAME_BYTES - CALL_ENVELOPE_BYTES) {
    throw new Error(copy("mobile_composer_image_too_large", { name }))
  }
  const attachment = await call("attachments.stage", { threadId, source: { dataUrl, name } })
  return { attachment, preview: asset.uri }
}
