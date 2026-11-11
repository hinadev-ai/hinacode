import { AGENT_IMAGE_MAX_BYTES } from "@shared/agentImages.ts"
import { File } from "expo-file-system"
import { ImageManipulator, SaveFormat } from "expo-image-manipulator"
import { type ImagePickerAsset, launchImageLibraryAsync } from "expo-image-picker"
import { Platform } from "react-native"
import { attachmentName, attachmentStem, base64Bytes, fitImage, type ImageFormat } from "@/lib/attachable-image"
import { call } from "@/lib/connection"
import { copy } from "@/lib/copy"
import type { DraftImage } from "@/stores/drafts"

const SHRUNK_LONG_EDGE = 2048
const SHRUNK_JPEG_QUALITY = 0.8

export const pickImages = async (): Promise<readonly ImagePickerAsset[]> => {
  const picked = await launchImageLibraryAsync({
    mediaTypes: ["images"],
    allowsMultipleSelection: true,
    quality: 1,
    base64: Platform.OS === "web",
  })
  return picked.canceled ? [] : picked.assets
}

const readHead = (file: File) => {
  const handle = file.open()
  try {
    return handle.readBytesSync(12)
  } finally {
    handle.close()
  }
}

const shrink = async (uri: string, format: "jpeg" | "png") => {
  const image = await ImageManipulator.manipulate(uri, {
    maxWidth: SHRUNK_LONG_EDGE,
    maxHeight: SHRUNK_LONG_EDGE,
  }).renderAsync()
  const saved = await image.saveAsync({
    format: format === "png" ? SaveFormat.PNG : SaveFormat.JPEG,
    compress: SHRUNK_JPEG_QUALITY,
    base64: true,
  })
  return saved.base64 ?? ""
}

type StageableImage = Pick<ImagePickerAsset, "uri" | "fileName" | "base64">

const encode = async (asset: StageableImage): Promise<{ base64: string; format: ImageFormat }> => {
  if (Platform.OS === "web" && asset.base64) {
    const head = Uint8Array.from(atob(asset.base64.slice(0, 16)), (char) => char.charCodeAt(0))
    const fit = fitImage(head, base64Bytes(asset.base64))
    return {
      base64: fit.kind === "as-is" ? asset.base64 : await shrink(asset.uri, fit.format),
      format: fit.format,
    }
  }
  const file = new File(asset.uri)
  const fit = fitImage(readHead(file), file.size)
  const base64 = fit.kind === "as-is" ? await file.base64() : await shrink(asset.uri, fit.format)
  return { base64, format: fit.format }
}

export const imageDataUrl = async (asset: StageableImage) => {
  const { base64, format } = await encode(asset).catch(() => {
    throw new Error(copy("mobile_composer_image_unreadable", { name: attachmentStem(asset.fileName) }))
  })
  const name = attachmentName(asset.fileName, format)
  if (base64Bytes(base64) > AGENT_IMAGE_MAX_BYTES) {
    throw new Error(copy("mobile_composer_image_too_large", { name }))
  }
  return { dataUrl: `data:image/${format};base64,${base64}`, name }
}

export const stageImage = async (threadId: string, asset: StageableImage): Promise<DraftImage> => {
  const source = await imageDataUrl(asset)
  const attachment = await call("attachments.stage", { threadId, source })
  return { attachment, preview: asset.uri }
}
