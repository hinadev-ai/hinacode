import { type EditDocument, visibleRect } from "./document.ts"
import { drawDocument, type EditSource } from "./render.ts"

const MIN_SCALE = 0.1

const renderAt = (source: EditSource, document: EditDocument, scale: number) => {
  const crop = visibleRect(document, source.width, source.height)
  const canvas = new OffscreenCanvas(
    Math.max(1, Math.round(crop.width * scale)),
    Math.max(1, Math.round(crop.height * scale)),
  )
  const ctx = canvas.getContext("2d")!
  ctx.scale(scale, scale)
  ctx.translate(-crop.x, -crop.y)
  drawDocument(ctx, source, document)
  return canvas.convertToBlob({ type: "image/png" })
}

export const exportDocument = async (source: EditSource, document: EditDocument, maxBytes: number) => {
  let scale = 1
  for (;;) {
    const blob = await renderAt(source, document, scale)
    if (blob.size <= maxBytes || scale <= MIN_SCALE) return blob
    scale = Math.max(MIN_SCALE, scale * Math.sqrt(maxBytes / blob.size) * 0.9)
  }
}
