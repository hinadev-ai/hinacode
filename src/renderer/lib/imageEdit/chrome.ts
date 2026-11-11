import type { Point, Rect } from "./document.ts"
import { type Handle, rectHandles } from "./geometry.ts"
import { toScreen, type View } from "./gesture.ts"

export const HANDLE_SIZE = 9

const screenRect = (view: View, rect: Rect): Rect => {
  const topLeft = toScreen(view, rect)
  return { x: topLeft.x, y: topLeft.y, width: rect.width * view.scale, height: rect.height * view.scale }
}

export const dimOutside = (ctx: CanvasRenderingContext2D, view: View, image: Rect, crop: Rect) => {
  const outer = screenRect(view, image)
  const inner = screenRect(view, crop)
  ctx.beginPath()
  ctx.rect(outer.x, outer.y, outer.width, outer.height)
  ctx.rect(inner.x, inner.y, inner.width, inner.height)
  ctx.fillStyle = "rgb(0 0 0 / 0.62)"
  ctx.fill("evenodd")
}

export const drawSelection = (
  ctx: CanvasRenderingContext2D,
  view: View,
  bounds: Rect,
  handles: ReadonlyArray<readonly [Handle, Point]>,
) => {
  const box = screenRect(view, bounds)
  ctx.save()
  ctx.lineWidth = 1
  ctx.setLineDash([4, 3])
  ctx.strokeStyle = "rgb(255 255 255 / 0.9)"
  ctx.shadowColor = "rgb(0 0 0 / 0.6)"
  ctx.shadowBlur = 2
  ctx.strokeRect(box.x - 4.5, box.y - 4.5, box.width + 9, box.height + 9)
  ctx.setLineDash([])
  for (const [, at] of handles) {
    const point = toScreen(view, at)
    ctx.fillStyle = "#ffffff"
    ctx.strokeStyle = "rgb(0 0 0 / 0.55)"
    ctx.beginPath()
    ctx.roundRect(point.x - HANDLE_SIZE / 2, point.y - HANDLE_SIZE / 2, HANDLE_SIZE, HANDLE_SIZE, 2)
    ctx.fill()
    ctx.stroke()
  }
  ctx.restore()
}

const CORNER_ARM = 16

export const drawCropFrame = (ctx: CanvasRenderingContext2D, view: View, crop: Rect) => {
  const box = screenRect(view, crop)
  ctx.save()
  ctx.lineWidth = 1
  ctx.setLineDash([3, 4])
  ctx.strokeStyle = "rgb(255 255 255 / 0.55)"
  ctx.strokeRect(box.x + 0.5, box.y + 0.5, box.width - 1, box.height - 1)
  ctx.setLineDash([])
  ctx.lineWidth = 3
  ctx.lineCap = "round"
  ctx.strokeStyle = "#ffffff"
  ctx.shadowColor = "rgb(0 0 0 / 0.6)"
  ctx.shadowBlur = 3
  for (const [handle, at] of rectHandles(crop)) {
    const point = toScreen(view, at)
    const armX = handle.includes("w") ? CORNER_ARM : handle.includes("e") ? -CORNER_ARM : 0
    const armY = handle.startsWith("n") ? CORNER_ARM : handle.startsWith("s") ? -CORNER_ARM : 0
    ctx.beginPath()
    if (armX !== 0 && armY !== 0) {
      ctx.moveTo(point.x + armX, point.y)
      ctx.lineTo(point.x, point.y)
      ctx.lineTo(point.x, point.y + armY)
    } else if (armX === 0) {
      ctx.moveTo(point.x - CORNER_ARM / 2, point.y)
      ctx.lineTo(point.x + CORNER_ARM / 2, point.y)
    } else {
      ctx.moveTo(point.x, point.y - CORNER_ARM / 2)
      ctx.lineTo(point.x, point.y + CORNER_ARM / 2)
    }
    ctx.stroke()
  }
  ctx.restore()
}

export const cursorFor = (handle: Handle) => {
  switch (handle) {
    case "nw":
    case "se":
      return "nwse-resize"
    case "ne":
    case "sw":
      return "nesw-resize"
    case "n":
    case "s":
      return "ns-resize"
    case "e":
    case "w":
      return "ew-resize"
    case "from":
    case "to":
      return "crosshair"
  }
}
