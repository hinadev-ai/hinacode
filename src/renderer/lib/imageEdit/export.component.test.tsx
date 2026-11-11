import { describe, expect, it } from "vitest"
import { type Command, emptyLog, push, replay } from "./document.ts"
import { exportDocument } from "./export.ts"
import type { EditSource } from "./render.ts"

const noise = async (width: number, height: number): Promise<EditSource> => {
  const canvas = new OffscreenCanvas(width, height)
  const ctx = canvas.getContext("2d")!
  const pixels = ctx.createImageData(width, height)
  let seed = 7
  for (let index = 0; index < pixels.data.length; index++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    pixels.data[index] = index % 4 === 3 ? 255 : (seed >> 16) & 255
  }
  ctx.putImageData(pixels, 0, 0)
  return { image: await createImageBitmap(canvas), width, height }
}

const pixelsOf = async (image: ImageBitmapSource, width: number, height: number) => {
  const canvas = new OffscreenCanvas(width, height)
  const ctx = canvas.getContext("2d")!
  ctx.drawImage(await createImageBitmap(image), 0, 0)
  return ctx.getImageData(0, 0, width, height).data
}

const documentOf = (...commands: ReadonlyArray<Command>) => replay(commands.reduce(push, emptyLog))

describe("exportDocument", () => {
  it("leaves no source pixel in place under a redaction", async () => {
    const source = await noise(200, 100)
    const document = documentOf({ type: "add", shape: { id: "r", kind: "redact", rect: { x: 0, y: 0, width: 200, height: 100 } } })
    const blob = await exportDocument(source, document, Number.POSITIVE_INFINITY)
    const before = await pixelsOf(source.image, 200, 100)
    const after = await pixelsOf(blob, 200, 100)
    let unchanged = 0
    for (let index = 0; index < before.length; index += 4) {
      if (before[index] === after[index] && before[index + 1] === after[index + 1] && before[index + 2] === after[index + 2])
        unchanged++
    }
    expect(unchanged / (200 * 100)).toBeLessThan(0.01)
  })

  it("exports only the cropped area at native resolution", async () => {
    const source = await noise(120, 80)
    const document = documentOf({ type: "crop", rect: { x: 10, y: 20, width: 30, height: 40 } })
    const bitmap = await createImageBitmap(await exportDocument(source, document, Number.POSITIVE_INFINITY))
    expect([bitmap.width, bitmap.height]).toEqual([30, 40])
    const sourcePixels = await pixelsOf(source.image, 120, 80)
    const exported = await pixelsOf(bitmap, 30, 40)
    const at = (20 * 120 + 10) * 4
    expect([...exported.slice(0, 3)]).toEqual([...sourcePixels.slice(at, at + 3)])
  })

  it("scales down until the PNG fits the byte budget", async () => {
    const source = await noise(1200, 900)
    const budget = 600_000
    const blob = await exportDocument(source, documentOf(), budget)
    const bitmap = await createImageBitmap(blob)
    expect(blob.size).toBeLessThanOrEqual(budget)
    expect(bitmap.width).toBeLessThan(1200)
    expect(bitmap.width / bitmap.height).toBeCloseTo(1200 / 900, 1)
  })
})
