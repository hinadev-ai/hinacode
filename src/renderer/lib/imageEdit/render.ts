import { type Color, type EditDocument, markerNumber, type Point, type Rect, type Shape } from "./document.ts"
import { intersectRect } from "./geometry.ts"

export interface EditSource {
  readonly image: CanvasImageSource
  readonly width: number
  readonly height: number
}

type Context = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D

type TextShape = Extract<Shape, { kind: "text" }>
type MarkerShape = Extract<Shape, { kind: "marker" }>

export const annotationUnit = (source: Pick<EditSource, "width" | "height">) =>
  Math.max(1, Math.max(source.width, source.height) / 800)

export const FONT_FAMILY = "ui-sans-serif, system-ui, sans-serif"

const inkOn = (color: Color) => (color === "#ffffff" || color === "#ffd60a" ? "#000000" : "#ffffff")

export const textPill = (color: Color) => ({
  background: color === "#ffffff" ? "#1c1c1e" : "#fffdf5",
  ink: color === "#ffd60a" ? "#1c1c1e" : color,
})

export interface TextLayout {
  readonly box: Rect
  readonly lines: ReadonlyArray<string>
  readonly fontSize: number
  readonly lineHeight: number
  readonly padding: number
}

export const layoutText = (ctx: Context, shape: Pick<TextShape, "at" | "text">, unit: number): TextLayout => {
  const fontSize = 16 * unit
  const lineHeight = fontSize * 1.3
  const padding = fontSize * 0.5
  const lines = shape.text.split("\n")
  ctx.font = `600 ${fontSize}px ${FONT_FAMILY}`
  const width = Math.max(fontSize, ...lines.map((line) => ctx.measureText(line).width))
  return {
    box: { x: shape.at.x, y: shape.at.y, width: width + padding * 2, height: lines.length * lineHeight + padding },
    lines,
    fontSize,
    lineHeight,
    padding,
  }
}

export const markerRadius = (unit: number) => 13 * unit

export const markerBox = (shape: Pick<MarkerShape, "at">, unit: number): Rect => {
  const radius = markerRadius(unit)
  return { x: shape.at.x - radius, y: shape.at.y - radius, width: radius * 2, height: radius * 2 }
}

const REDACTION_COLOR = "#1c1c1e"

const drawRedaction = (ctx: Context, source: EditSource, shape: Extract<Shape, { kind: "redact" }>) => {
  const area = intersectRect(roundRect(shape.rect), { x: 0, y: 0, width: source.width, height: source.height })
  if (area.width < 1 || area.height < 1) return
  ctx.fillStyle = REDACTION_COLOR
  ctx.fillRect(area.x, area.y, area.width, area.height)
}

const roundRect = (rect: Rect): Rect => {
  const x = Math.floor(rect.x)
  const y = Math.floor(rect.y)
  return { x, y, width: Math.ceil(rect.x + rect.width) - x, height: Math.ceil(rect.y + rect.height) - y }
}

const drawArrow = (ctx: Context, from: Point, to: Point, width: number) => {
  const length = Math.hypot(to.x - from.x, to.y - from.y)
  if (length < 1) return
  const head = Math.min(width * 4.5, length * 0.6)
  const angle = Math.atan2(to.y - from.y, to.x - from.x)
  const base = { x: to.x - Math.cos(angle) * head * 0.8, y: to.y - Math.sin(angle) * head * 0.8 }
  ctx.beginPath()
  ctx.moveTo(from.x, from.y)
  ctx.lineTo(base.x, base.y)
  ctx.stroke()
  ctx.beginPath()
  ctx.moveTo(to.x, to.y)
  ctx.lineTo(to.x - Math.cos(angle - 0.45) * head, to.y - Math.sin(angle - 0.45) * head)
  ctx.lineTo(to.x - Math.cos(angle + 0.45) * head, to.y - Math.sin(angle + 0.45) * head)
  ctx.closePath()
  ctx.fill()
  ctx.stroke()
}

const drawPen = (ctx: Context, points: ReadonlyArray<Point>) => {
  const [first, ...rest] = points
  if (!first) return
  ctx.beginPath()
  ctx.moveTo(first.x, first.y)
  if (rest.length === 0) ctx.lineTo(first.x + 0.01, first.y)
  for (let index = 0; index < rest.length - 1; index++) {
    const point = rest[index]!
    const next = rest[index + 1]!
    ctx.quadraticCurveTo(point.x, point.y, (point.x + next.x) / 2, (point.y + next.y) / 2)
  }
  const last = rest.at(-1)
  if (last) ctx.lineTo(last.x, last.y)
  ctx.stroke()
}

const drawText = (ctx: Context, shape: TextShape, unit: number) => {
  const layout = layoutText(ctx, shape, unit)
  const { box, padding, lineHeight, fontSize } = layout
  const pill = textPill(shape.color)
  ctx.fillStyle = pill.background
  ctx.beginPath()
  ctx.roundRect(box.x, box.y, box.width, box.height, Math.min(box.height / 2, fontSize))
  ctx.fill()
  ctx.shadowColor = "transparent"
  ctx.fillStyle = pill.ink
  ctx.textBaseline = "middle"
  layout.lines.forEach((line, index) => {
    ctx.fillText(line, box.x + padding, box.y + padding / 2 + lineHeight * (index + 0.5))
  })
}

const drawMarker = (ctx: Context, shape: MarkerShape, n: number, unit: number) => {
  const radius = markerRadius(unit)
  ctx.beginPath()
  ctx.arc(shape.at.x, shape.at.y, radius, 0, Math.PI * 2)
  ctx.fillStyle = shape.color
  ctx.fill()
  ctx.shadowColor = "transparent"
  ctx.lineWidth = 2 * unit
  ctx.strokeStyle = inkOn(shape.color)
  ctx.stroke()
  ctx.fillStyle = inkOn(shape.color)
  ctx.font = `700 ${radius * 1.15}px ${FONT_FAMILY}`
  ctx.textAlign = "center"
  ctx.textBaseline = "middle"
  ctx.fillText(String(n), shape.at.x, shape.at.y + radius * 0.06)
}

const drawShape = (ctx: Context, shape: Shape, shapes: ReadonlyArray<Shape>, unit: number) => {
  if (shape.kind === "redact") return
  const width = 3 * unit
  ctx.save()
  ctx.lineWidth = width
  ctx.lineCap = "round"
  ctx.lineJoin = "round"
  ctx.strokeStyle = shape.color
  ctx.fillStyle = shape.color
  ctx.shadowColor = "rgb(0 0 0 / 0.35)"
  ctx.shadowBlur = 4 * unit
  ctx.shadowOffsetY = unit
  switch (shape.kind) {
    case "arrow":
      drawArrow(ctx, shape.from, shape.to, width)
      break
    case "rect":
      ctx.beginPath()
      ctx.roundRect(shape.rect.x, shape.rect.y, shape.rect.width, shape.rect.height, 2 * unit)
      ctx.stroke()
      break
    case "ellipse":
      ctx.beginPath()
      ctx.ellipse(
        shape.rect.x + shape.rect.width / 2,
        shape.rect.y + shape.rect.height / 2,
        shape.rect.width / 2,
        shape.rect.height / 2,
        0,
        0,
        Math.PI * 2,
      )
      ctx.stroke()
      break
    case "pen":
      drawPen(ctx, shape.points)
      break
    case "text":
      drawText(ctx, shape, unit)
      break
    case "marker":
      drawMarker(ctx, shape, markerNumber(shapes, shape.id), unit)
      break
  }
  ctx.restore()
}

export const drawDocument = (ctx: Context, source: EditSource, document: EditDocument, clip?: Rect) => {
  const unit = annotationUnit(source)
  ctx.drawImage(source.image, 0, 0, source.width, source.height)
  ctx.save()
  if (clip) {
    ctx.beginPath()
    ctx.rect(clip.x, clip.y, clip.width, clip.height)
    ctx.clip()
  }
  for (const shape of document.shapes) if (shape.kind === "redact") drawRedaction(ctx, source, shape)
  for (const shape of document.shapes) drawShape(ctx, shape, document.shapes, unit)
  ctx.restore()
}
