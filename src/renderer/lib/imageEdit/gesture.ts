import type { Color, Command, EditDocument, Point, Rect, Shape } from "./document.ts"
import {
  type Handle,
  clampPoint,
  intersectRect,
  rectFromPoints,
  resizeRect,
  resizeShape,
  snapToEighth,
  squareCorner,
  translate,
} from "./geometry.ts"

export type Tool = "select" | "arrow" | "rect" | "ellipse" | "pen" | "text" | "marker" | "redact"

export const TOOL_KEYS: ReadonlyArray<readonly [Tool, string]> = [
  ["select", "v"],
  ["arrow", "a"],
  ["rect", "r"],
  ["ellipse", "e"],
  ["pen", "f"],
  ["text", "t"],
  ["marker", "c"],
  ["redact", "d"],
]

export interface View {
  readonly scale: number
  readonly offsetX: number
  readonly offsetY: number
}

export interface Size {
  readonly width: number
  readonly height: number
}

const MAX_SCALE = 2

export const fitView = (rect: Rect, stage: Size, padding: number): View => {
  const scale = Math.min(
    MAX_SCALE,
    Math.max(0.01, (stage.width - padding * 2) / rect.width),
    Math.max(0.01, (stage.height - padding * 2) / rect.height),
  )
  return {
    scale,
    offsetX: (stage.width - rect.width * scale) / 2 - rect.x * scale,
    offsetY: (stage.height - rect.height * scale) / 2 - rect.y * scale,
  }
}

export const toImage = (view: View, x: number, y: number): Point => ({
  x: (x - view.offsetX) / view.scale,
  y: (y - view.offsetY) / view.scale,
})

export const toScreen = (view: View, point: Point): Point => ({
  x: point.x * view.scale + view.offsetX,
  y: point.y * view.scale + view.offsetY,
})

export type Gesture =
  | { readonly kind: "idle" }
  | { readonly kind: "draw"; readonly anchor: Point; readonly shape: Shape }
  | { readonly kind: "move"; readonly start: Point; readonly original: Shape; readonly shape: Shape }
  | { readonly kind: "resize"; readonly handle: Handle; readonly original: Shape; readonly shape: Shape }
  | {
      readonly kind: "crop"
      readonly handle: Handle
      readonly original: Rect
      readonly rect: Rect
      readonly view: View
    }

export const idle: Gesture = { kind: "idle" }

export type DrawingTool = Extract<Tool, "arrow" | "rect" | "ellipse" | "redact" | "pen">

export const isDrawingTool = (tool: Tool): tool is DrawingTool =>
  tool === "arrow" || tool === "rect" || tool === "ellipse" || tool === "redact" || tool === "pen"

export const startDrawing = (tool: DrawingTool, id: string, color: Color, at: Point): Gesture => {
  const rect = { x: at.x, y: at.y, width: 0, height: 0 }
  switch (tool) {
    case "arrow":
      return { kind: "draw", anchor: at, shape: { id, kind: "arrow", from: at, to: at, color } }
    case "rect":
    case "ellipse":
      return { kind: "draw", anchor: at, shape: { id, kind: tool, rect, color } }
    case "redact":
      return { kind: "draw", anchor: at, shape: { id, kind: "redact", rect } }
    case "pen":
      return { kind: "draw", anchor: at, shape: { id, kind: "pen", points: [at], color } }
  }
}

export interface DragOptions {
  readonly shift: boolean
  readonly image: Rect
  readonly penStep: number
}

const drawTo = (shape: Shape, anchor: Point, at: Point, { shift, penStep }: DragOptions): Shape => {
  switch (shape.kind) {
    case "arrow":
      return { ...shape, to: shift ? snapToEighth(shape.from, at) : at }
    case "rect":
    case "ellipse":
    case "redact":
      return { ...shape, rect: rectFromPoints(anchor, shift ? squareCorner(anchor, at) : at) }
    case "pen": {
      const last = shape.points.at(-1)!
      return Math.hypot(at.x - last.x, at.y - last.y) < penStep ? shape : { ...shape, points: [...shape.points, at] }
    }
    default:
      return shape
  }
}

const resizeTo = (shape: Shape, handle: Handle, at: Point, shift: boolean): Shape => {
  if (shape.kind !== "arrow" || !shift) return resizeShape(shape, handle, at)
  return resizeShape(shape, handle, snapToEighth(handle === "to" ? shape.from : shape.to, at))
}

export const dragTo = (gesture: Gesture, at: Point, options: DragOptions): Gesture => {
  switch (gesture.kind) {
    case "idle":
      return gesture
    case "draw":
      return { ...gesture, shape: drawTo(gesture.shape, gesture.anchor, at, options) }
    case "move": {
      const dx = at.x - gesture.start.x
      const dy = at.y - gesture.start.y
      return { ...gesture, shape: dx === 0 && dy === 0 ? gesture.original : translate(gesture.original, dx, dy) }
    }
    case "resize":
      return { ...gesture, shape: resizeTo(gesture.original, gesture.handle, at, options.shift) }
    case "crop": {
      const resized = resizeRect(gesture.original, gesture.handle, clampPoint(at, options.image))
      return { ...gesture, rect: intersectRect(resized, options.image) }
    }
  }
}

const isClick = (shape: Shape, minSize: number) => {
  switch (shape.kind) {
    case "arrow":
      return Math.hypot(shape.to.x - shape.from.x, shape.to.y - shape.from.y) < minSize
    case "rect":
    case "ellipse":
    case "redact":
      return shape.rect.width < minSize && shape.rect.height < minSize
    default:
      return false
  }
}

const sameRect = (a: Rect, b: Rect) => a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height

export const finish = (gesture: Gesture, image: Rect, minSize: number): Command | null => {
  switch (gesture.kind) {
    case "idle":
      return null
    case "draw":
      return isClick(gesture.shape, minSize) ? null : { type: "add", shape: gesture.shape }
    case "move":
    case "resize":
      return gesture.shape === gesture.original ? null : { type: "update", shape: gesture.shape }
    case "crop":
      if (gesture.rect.width < minSize || gesture.rect.height < minSize) return null
      if (sameRect(gesture.rect, gesture.original)) return null
      return { type: "crop", rect: sameRect(gesture.rect, image) ? null : gesture.rect }
  }
}

export const previewDocument = (document: EditDocument, gesture: Gesture, hiddenId: string | null): EditDocument => {
  const shown = (shapes: ReadonlyArray<Shape>) =>
    hiddenId === null ? shapes : shapes.filter((shape) => shape.id !== hiddenId)
  switch (gesture.kind) {
    case "idle":
      return hiddenId === null ? document : { ...document, shapes: shown(document.shapes) }
    case "draw":
      return { ...document, shapes: shown([...document.shapes, gesture.shape]) }
    case "move":
    case "resize":
      return {
        ...document,
        shapes: shown(document.shapes.map((shape) => (shape.id === gesture.shape.id ? gesture.shape : shape))),
      }
    case "crop":
      return { ...document, crop: gesture.rect, shapes: shown(document.shapes) }
  }
}
