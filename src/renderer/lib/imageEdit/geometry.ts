import type { Point, Rect, Shape } from "./document.ts"

export type Handle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "from" | "to"

export const rectFromPoints = (a: Point, b: Point): Rect => ({
  x: Math.min(a.x, b.x),
  y: Math.min(a.y, b.y),
  width: Math.abs(b.x - a.x),
  height: Math.abs(b.y - a.y),
})

export const squareCorner = (anchor: Point, to: Point): Point => {
  const side = Math.max(Math.abs(to.x - anchor.x), Math.abs(to.y - anchor.y))
  return { x: anchor.x + Math.sign(to.x - anchor.x) * side, y: anchor.y + Math.sign(to.y - anchor.y) * side }
}

export const snapToEighth = (anchor: Point, to: Point): Point => {
  const length = Math.hypot(to.x - anchor.x, to.y - anchor.y)
  const angle = Math.round(Math.atan2(to.y - anchor.y, to.x - anchor.x) / (Math.PI / 4)) * (Math.PI / 4)
  return { x: anchor.x + Math.cos(angle) * length, y: anchor.y + Math.sin(angle) * length }
}

export const clampPoint = (point: Point, bounds: Rect): Point => ({
  x: Math.min(Math.max(point.x, bounds.x), bounds.x + bounds.width),
  y: Math.min(Math.max(point.y, bounds.y), bounds.y + bounds.height),
})

export const intersectRect = (a: Rect, b: Rect): Rect => {
  const x = Math.max(a.x, b.x)
  const y = Math.max(a.y, b.y)
  return {
    x,
    y,
    width: Math.max(0, Math.min(a.x + a.width, b.x + b.width) - x),
    height: Math.max(0, Math.min(a.y + a.height, b.y + b.height) - y),
  }
}

export const containsPoint = (rect: Rect, point: Point, slop = 0) =>
  point.x >= rect.x - slop &&
  point.x <= rect.x + rect.width + slop &&
  point.y >= rect.y - slop &&
  point.y <= rect.y + rect.height + slop

export const rectHandles = (rect: Rect): ReadonlyArray<readonly [Handle, Point]> => {
  const { x, y, width, height } = rect
  const midX = x + width / 2
  const midY = y + height / 2
  return [
    ["nw", { x, y }],
    ["n", { x: midX, y }],
    ["ne", { x: x + width, y }],
    ["e", { x: x + width, y: midY }],
    ["se", { x: x + width, y: y + height }],
    ["s", { x: midX, y: y + height }],
    ["sw", { x, y: y + height }],
    ["w", { x, y: midY }],
  ]
}

export const resizeRect = (rect: Rect, handle: Handle, to: Point): Rect => {
  let left = rect.x
  let top = rect.y
  let right = rect.x + rect.width
  let bottom = rect.y + rect.height
  if (handle.includes("w")) left = to.x
  if (handle.includes("e")) right = to.x
  if (handle.startsWith("n")) top = to.y
  if (handle.startsWith("s")) bottom = to.y
  return rectFromPoints({ x: left, y: top }, { x: right, y: bottom })
}

export const shapeHandles = (shape: Shape): ReadonlyArray<readonly [Handle, Point]> => {
  switch (shape.kind) {
    case "arrow":
      return [
        ["from", shape.from],
        ["to", shape.to],
      ]
    case "rect":
    case "ellipse":
    case "redact":
      return rectHandles(shape.rect)
    default:
      return []
  }
}

export const resizeShape = (shape: Shape, handle: Handle, to: Point): Shape => {
  switch (shape.kind) {
    case "arrow":
      return handle === "from" ? { ...shape, from: to } : handle === "to" ? { ...shape, to } : shape
    case "rect":
    case "ellipse":
    case "redact":
      return { ...shape, rect: resizeRect(shape.rect, handle, to) }
    default:
      return shape
  }
}

const shift = (point: Point, dx: number, dy: number): Point => ({ x: point.x + dx, y: point.y + dy })

export const translate = (shape: Shape, dx: number, dy: number): Shape => {
  switch (shape.kind) {
    case "arrow":
      return { ...shape, from: shift(shape.from, dx, dy), to: shift(shape.to, dx, dy) }
    case "rect":
    case "ellipse":
    case "redact":
      return { ...shape, rect: { ...shape.rect, x: shape.rect.x + dx, y: shape.rect.y + dy } }
    case "pen":
      return { ...shape, points: shape.points.map((point) => shift(point, dx, dy)) }
    case "text":
    case "marker":
      return { ...shape, at: shift(shape.at, dx, dy) }
  }
}

export const distanceToSegment = (point: Point, a: Point, b: Point) => {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const lengthSquared = dx * dx + dy * dy
  const t =
    lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared))
  return Math.hypot(point.x - (a.x + t * dx), point.y - (a.y + t * dy))
}

const distanceToPolyline = (point: Point, points: ReadonlyArray<Point>) => {
  if (points.length === 1) return Math.hypot(point.x - points[0]!.x, point.y - points[0]!.y)
  let nearest = Number.POSITIVE_INFINITY
  for (let index = 1; index < points.length; index++) {
    nearest = Math.min(nearest, distanceToSegment(point, points[index - 1]!, points[index]!))
  }
  return nearest
}

const distanceToRectEdge = (point: Point, rect: Rect) => {
  const { x, y, width, height } = rect
  return Math.min(
    distanceToSegment(point, { x, y }, { x: x + width, y }),
    distanceToSegment(point, { x: x + width, y }, { x: x + width, y: y + height }),
    distanceToSegment(point, { x, y: y + height }, { x: x + width, y: y + height }),
    distanceToSegment(point, { x, y }, { x, y: y + height }),
  )
}

const distanceToEllipseEdge = (point: Point, rect: Rect) => {
  const radiusX = rect.width / 2
  const radiusY = rect.height / 2
  if (radiusX === 0 || radiusY === 0) return distanceToRectEdge(point, rect)
  const nx = (point.x - (rect.x + radiusX)) / radiusX
  const ny = (point.y - (rect.y + radiusY)) / radiusY
  return Math.abs(Math.hypot(nx, ny) - 1) * Math.min(radiusX, radiusY)
}

export type BoxOf = (shape: Extract<Shape, { kind: "text" | "marker" }>) => Rect

export const hitsShape = (shape: Shape, point: Point, slop: number, boxOf: BoxOf) => {
  switch (shape.kind) {
    case "arrow":
      return distanceToSegment(point, shape.from, shape.to) <= slop
    case "pen":
      return distanceToPolyline(point, shape.points) <= slop
    case "rect":
      return distanceToRectEdge(point, shape.rect) <= slop
    case "ellipse":
      return distanceToEllipseEdge(point, shape.rect) <= slop
    case "redact":
      return containsPoint(shape.rect, point, slop)
    case "text":
    case "marker":
      return containsPoint(boxOf(shape), point, slop)
  }
}

export const topmostShapeAt = (shapes: ReadonlyArray<Shape>, point: Point, slop: number, boxOf: BoxOf) =>
  shapes.findLast((shape) => hitsShape(shape, point, slop, boxOf))
