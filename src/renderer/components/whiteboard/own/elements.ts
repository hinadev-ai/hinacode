import type { WhiteboardElement } from "../../../../shared/artifact.ts"

export type OwnElement = {
  readonly id: string
  readonly type: string
  readonly version: number
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  readonly isDeleted?: boolean
  readonly containerId?: string | null
  readonly text?: string
  readonly label?: { readonly text: string }
  readonly start?: { readonly id: string }
  readonly end?: { readonly id: string }
  readonly strokeColor?: string
  readonly backgroundColor?: string
  readonly fillStyle?: string
  readonly strokeStyle?: string
}

export type Point = { readonly x: number; readonly y: number }
export type Bounds = { readonly x: number; readonly y: number; readonly width: number; readonly height: number }

export const SHAPE_TYPES = ["rectangle", "ellipse", "diamond"] as const
export const TOOL_TYPES = [...SHAPE_TYPES, "arrow", "text"] as const

export type ShapeType = (typeof SHAPE_TYPES)[number]
export type ToolType = (typeof TOOL_TYPES)[number]
export type ArrowType = "arrow" | "line"

export const isShape = (element: OwnElement) => (SHAPE_TYPES as ReadonlyArray<string>).includes(element.type)
export const isArrow = (element: OwnElement) => element.type === "arrow" || element.type === "line"
export const isText = (element: OwnElement) => element.type === "text"

export const DEFAULT_SHAPE_WIDTH = 180
export const DEFAULT_SHAPE_HEIGHT = 90
export const TEXT_FONT_SIZE = 16
export const LABEL_FONT_SIZE = 15
export const LABEL_LINE_HEIGHT = 18

export const numberOr = (value: unknown, fallback: number) =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback

export const stringOr = (value: unknown) => (typeof value === "string" ? value : undefined)

const recordOr = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined

const bindingId = (value: unknown) => {
  const record = recordOr(value)
  return record === undefined ? undefined : (stringOr(record["id"]) ?? stringOr(record["elementId"]))
}

const labelOf = (value: unknown) => {
  const text = stringOr(recordOr(value)?.["text"])
  return text === undefined || text === "" ? undefined : { text }
}

export const completeElement = (raw: WhiteboardElement): OwnElement => {
  const type = stringOr(raw["type"]) ?? "rectangle"
  const text = stringOr(raw["text"])
  const label = labelOf(raw["label"])
  const start = bindingId(raw["start"]) ?? bindingId(raw["startBinding"])
  const end = bindingId(raw["end"]) ?? bindingId(raw["endBinding"])
  const width = numberOr(raw["width"], type === "text" ? Math.max(80, (text?.length ?? 6) * 9) : DEFAULT_SHAPE_WIDTH)
  const height = numberOr(raw["height"], type === "text" ? 24 : DEFAULT_SHAPE_HEIGHT)
  return {
    ...raw,
    id: raw.id,
    type,
    version: numberOr(raw["version"], 0),
    x: numberOr(raw["x"], 0),
    y: numberOr(raw["y"], 0),
    width,
    height,
    ...(text === undefined ? {} : { text }),
    ...(label === undefined ? {} : { label }),
    ...(start === undefined ? {} : { start: { id: start } }),
    ...(end === undefined ? {} : { end: { id: end } }),
  }
}

export const normalizeScene = (raw: ReadonlyArray<WhiteboardElement>): OwnElement[] =>
  foldBoundLabels(raw.map(completeElement))

export const foldBoundLabels = (elements: ReadonlyArray<OwnElement>): OwnElement[] => {
  const present = new Set(elements.map((element) => element.id))
  const bound = new Map<string, string>()
  for (const element of elements) {
    if (element.type !== "text" || element.containerId == null) continue
    if (present.has(element.containerId) && element.text !== undefined) bound.set(element.containerId, element.text)
  }
  return elements
    .filter((element) => !(element.type === "text" && element.containerId != null && bound.has(element.containerId)))
    .map((element) => {
      const text = bound.get(element.id)
      return text === undefined ? element : { ...element, label: { text } }
    })
}

export const nextVersion = (elements: ReadonlyArray<OwnElement>) =>
  elements.reduce((highest, element) => Math.max(highest, element.version), 0) + 1

export const boundsOf = (element: OwnElement): Bounds => ({
  x: element.x,
  y: element.y,
  width: element.width,
  height: element.height,
})

export const centerOf = (bounds: Bounds): Point => ({ x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 })

export const unionBounds = (list: ReadonlyArray<Bounds>): Bounds | null => {
  if (list.length === 0) return null
  const left = Math.min(...list.map((bounds) => bounds.x))
  const top = Math.min(...list.map((bounds) => bounds.y))
  const right = Math.max(...list.map((bounds) => bounds.x + bounds.width))
  const bottom = Math.max(...list.map((bounds) => bounds.y + bounds.height))
  return { x: left, y: top, width: right - left, height: bottom - top }
}

export const BOUNDS_MARGIN = 32

export const contentBounds = (elements: ReadonlyArray<OwnElement>): Bounds | null => {
  const live = elements.filter((element) => element.isDeleted !== true && !isArrow(element))
  return unionBounds(live.map(boundsOf))
}

const anchorTowards = (bounds: Bounds, toward: Point): Point => {
  const center = centerOf(bounds)
  const dx = toward.x - center.x
  const dy = toward.y - center.y
  if (dx === 0 && dy === 0) return center
  const halfWidth = Math.max(bounds.width / 2, 1)
  const halfHeight = Math.max(bounds.height / 2, 1)
  const scale = 1 / Math.max(Math.abs(dx) / halfWidth, Math.abs(dy) / halfHeight)
  return { x: center.x + dx * scale, y: center.y + dy * scale }
}

export type ArrowGeometry = { readonly x1: number; readonly y1: number; readonly x2: number; readonly y2: number }

export const arrowGeometry = (arrow: OwnElement, byId: ReadonlyMap<string, OwnElement>): ArrowGeometry => {
  const startShape = arrow.start === undefined ? undefined : byId.get(arrow.start.id)
  const endShape = arrow.end === undefined ? undefined : byId.get(arrow.end.id)
  const free: Point = { x: arrow.x, y: arrow.y }
  const freeEnd: Point = { x: arrow.x + arrow.width, y: arrow.y + arrow.height }
  const targetStart = startShape === undefined ? free : centerOf(boundsOf(startShape))
  const targetEnd = endShape === undefined ? freeEnd : centerOf(boundsOf(endShape))
  const from = startShape === undefined ? targetStart : anchorTowards(boundsOf(startShape), targetEnd)
  const to = endShape === undefined ? targetEnd : anchorTowards(boundsOf(endShape), targetStart)
  return { x1: from.x, y1: from.y, x2: to.x, y2: to.y }
}

export const arrowBounds = (arrow: OwnElement, byId: ReadonlyMap<string, OwnElement>): Bounds => {
  const { x1, y1, x2, y2 } = arrowGeometry(arrow, byId)
  return { x: Math.min(x1, x2), y: Math.min(y1, y2), width: Math.abs(x2 - x1), height: Math.abs(y2 - y1) }
}

const distanceToSegment = (point: Point, a: Point, b: Point) => {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const lengthSquared = dx * dx + dy * dy
  const t =
    lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared))
  return Math.hypot(point.x - (a.x + t * dx), point.y - (a.y + t * dy))
}

export const inShape = (element: OwnElement, point: Point) => {
  const bounds = boundsOf(element)
  if (element.type === "ellipse") {
    const halfWidth = Math.max(bounds.width / 2, 1)
    const halfHeight = Math.max(bounds.height / 2, 1)
    const dx = (point.x - centerOf(bounds).x) / halfWidth
    const dy = (point.y - centerOf(bounds).y) / halfHeight
    return dx * dx + dy * dy <= 1
  }
  if (element.type === "diamond") {
    const center = centerOf(bounds)
    const normalized =
      Math.abs(point.x - center.x) / Math.max(bounds.width / 2, 1) +
      Math.abs(point.y - center.y) / Math.max(bounds.height / 2, 1)
    return normalized <= 1
  }
  return (
    point.x >= bounds.x &&
    point.x <= bounds.x + bounds.width &&
    point.y >= bounds.y &&
    point.y <= bounds.y + bounds.height
  )
}

export const HIT_TOLERANCE = 8

export const hitTest = (
  elements: ReadonlyArray<OwnElement>,
  point: Point,
  byId: ReadonlyMap<string, OwnElement>,
): OwnElement | undefined => {
  for (let index = elements.length - 1; index >= 0; index -= 1) {
    const element = elements[index]
    if (element === undefined || element.isDeleted === true) continue
    if (isArrow(element)) {
      const { x1, y1, x2, y2 } = arrowGeometry(element, byId)
      if (distanceToSegment(point, { x: x1, y: y1 }, { x: x2, y: y2 }) <= HIT_TOLERANCE) return element
      continue
    }
    if (inShape(element, point)) return element
  }
  return undefined
}

export const intersects = (a: Bounds, b: Bounds) =>
  a.x <= b.x + b.width && a.x + a.width >= b.x && a.y <= b.y + b.height && a.y + a.height >= b.y

export const elementsInBounds = (
  elements: ReadonlyArray<OwnElement>,
  rect: Bounds,
  byId: ReadonlyMap<string, OwnElement>,
) =>
  elements
    .filter((element) => element.isDeleted !== true)
    .filter((element) => intersects(isArrow(element) ? arrowBounds(element, byId) : boundsOf(element), rect))
    .map((element) => element.id)

export const byIdOf = (elements: ReadonlyArray<OwnElement>) => new Map(elements.map((element) => [element.id, element]))

export const flattenBounds = (from: Point, to: Point): Bounds => ({
  x: Math.min(from.x, to.x),
  y: Math.min(from.y, to.y),
  width: Math.abs(to.x - from.x),
  height: Math.abs(to.y - from.y),
})

export const moveElements = (elements: ReadonlyArray<OwnElement>, ids: ReadonlySet<string>, dx: number, dy: number) =>
  elements.map((element) => (ids.has(element.id) ? { ...element, x: element.x + dx, y: element.y + dy } : element))

export const resizeElement = (element: OwnElement, from: Bounds, to: Bounds): OwnElement => {
  const scaleX = from.width === 0 ? 1 : to.width / from.width
  const scaleY = from.height === 0 ? 1 : to.height / from.height
  return {
    ...element,
    x: to.x + (element.x - from.x) * scaleX,
    y: to.y + (element.y - from.y) * scaleY,
    width: Math.max(8, element.width * scaleX),
    height: Math.max(8, element.height * scaleY),
  }
}

export const resizeElements = (
  elements: ReadonlyArray<OwnElement>,
  ids: ReadonlySet<string>,
  from: Bounds,
  to: Bounds,
) => elements.map((element) => (ids.has(element.id) ? resizeElement(element, from, to) : element))

export const bumpChanged = (previous: ReadonlyArray<OwnElement>, next: ReadonlyArray<OwnElement>): OwnElement[] => {
  const before = new Map(previous.map((element) => [element.id, element]))
  let version = nextVersion(next)
  return next.map((element) => (before.get(element.id) === element ? element : { ...element, version: version++ }))
}

export const tombstone = (elements: ReadonlyArray<OwnElement>, ids: ReadonlySet<string>): OwnElement[] => {
  let version = nextVersion(elements)
  return elements.map((element) =>
    ids.has(element.id) ? { ...element, isDeleted: true, version: version++ } : element,
  )
}

export const labelTextOf = (element: OwnElement) =>
  element.type === "text" ? (element.text ?? "") : (element.label?.text ?? "")

export const wrapText = (text: string, maxCharacters: number) => {
  const limit = Math.max(1, Math.floor(maxCharacters))
  const lines: string[] = []
  for (const paragraph of text.split("\n")) {
    let line = ""
    for (const word of paragraph.split(/\s+/)) {
      if (word === "") continue
      const candidate = line === "" ? word : `${line} ${word}`
      if (candidate.length > limit && line !== "") {
        lines.push(line)
        line = word
      } else {
        line = candidate
      }
    }
    lines.push(line)
  }
  return lines.length === 0 ? [""] : lines
}

export const charactersPerLine = (width: number, fontSize: number) => Math.max(4, Math.floor(width / (fontSize * 0.58)))

export const fitView = (size: { width: number; height: number }, bounds: Bounds | null) => {
  const padded =
    bounds === null
      ? { x: -200, y: -150, width: 400, height: 300 }
      : {
          x: bounds.x - BOUNDS_MARGIN,
          y: bounds.y - BOUNDS_MARGIN,
          width: bounds.width + BOUNDS_MARGIN * 2,
          height: bounds.height + BOUNDS_MARGIN * 2,
        }
  const zoom = Math.min(1.2, size.width / padded.width, size.height / padded.height)
  const safeZoom = Number.isFinite(zoom) && zoom > 0 ? Math.max(0.2, Math.min(4, zoom)) : 1
  return {
    zoom: safeZoom,
    x: (size.width - padded.width * safeZoom) / 2 - padded.x * safeZoom,
    y: (size.height - padded.height * safeZoom) / 2 - padded.y * safeZoom,
  }
}

export const zoomAt = (view: { x: number; y: number; zoom: number }, point: Point, factor: number) => {
  const zoom = Math.max(0.2, Math.min(4, view.zoom * factor))
  const scale = zoom / view.zoom
  return { zoom, x: point.x - (point.x - view.x) * scale, y: point.y - (point.y - view.y) * scale }
}

export const toWorld = (view: { x: number; y: number; zoom: number }, point: Point): Point => ({
  x: (point.x - view.x) / view.zoom,
  y: (point.y - view.y) / view.zoom,
})

export const toScreen = (view: { x: number; y: number; zoom: number }, point: Point): Point => ({
  x: point.x * view.zoom + view.x,
  y: point.y * view.zoom + view.y,
})

export const centerOn = (size: { width: number; height: number }, view: { zoom: number }, bounds: Bounds) => {
  const center = centerOf(bounds)
  return { zoom: view.zoom, x: size.width / 2 - center.x * view.zoom, y: size.height / 2 - center.y * view.zoom }
}
