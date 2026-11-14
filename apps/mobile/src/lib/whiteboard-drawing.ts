import type { WhiteboardElement, WhiteboardScene } from "@shared/artifact.ts"

type Point = readonly [number, number]
type Box = { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
type ShapeKind = "rectangle" | "ellipse" | "diamond"
type Stroke = {
  readonly color: string
  readonly width: number
  readonly style: "solid" | "dashed" | "dotted"
  readonly opacity: number
}

export type Mark =
  | {
      readonly kind: "shape"
      readonly shape: ShapeKind
      readonly box: Box
      readonly stroke: Stroke
      readonly fill: string | null
      readonly rounded: boolean
      readonly angle: number
    }
  | {
      readonly kind: "text"
      readonly box: Box
      readonly text: string
      readonly fontSize: number
      readonly color: string
      readonly align: "left" | "center" | "right"
      readonly middle: boolean
      readonly wrap: boolean
      readonly backdrop: boolean
      readonly opacity: number
      readonly angle: number
    }
  | {
      readonly kind: "path"
      readonly points: readonly Point[]
      readonly stroke: Stroke
      readonly fill: string | null
      readonly arrowheads: { readonly start: boolean; readonly end: boolean }
    }
  | { readonly kind: "image"; readonly box: Box; readonly href: string; readonly angle: number }
  | { readonly kind: "frame"; readonly box: Box; readonly name: string }

export type Drawing = { readonly marks: readonly Mark[]; readonly bounds: Box }

const INK = "#1e1e1e"
const SHAPE_SIZE = 100
const FONT_SIZE = 20
const LINE_HEIGHT = 1.25
const FRAME_PADDING = 24
const PAGE_PADDING = 40
const ARROWHEAD = 14
const CANVAS = { light: "#ffffff", dark: "#121212" } as const
const FLEX_ALIGN = { left: "flex-start", center: "center", right: "flex-end" } as const

const field = (element: object, key: string): unknown => (element as Record<string, unknown>)[key]
const num = (element: object, key: string) => {
  const value = field(element, key)
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}
const str = (element: object, key: string) => {
  const value = field(element, key)
  return typeof value === "string" ? value : undefined
}
const obj = (element: object, key: string) => {
  const value = field(element, key)
  return typeof value === "object" && value !== null ? value : undefined
}

const SAFE_COLOR = /^[#\w(),.%\s-]{1,40}$/
const safeColor = (value: string | undefined, fallback: string) =>
  value !== undefined && SAFE_COLOR.test(value) ? value : fallback
const fillOf = (element: object) => {
  const value = str(element, "backgroundColor")
  return value === undefined || value === "transparent" || !SAFE_COLOR.test(value) ? null : value
}

const isSkeleton = (element: WhiteboardElement) => num(element, "version") === undefined
const center = (box: Box): Point => [box.x + box.width / 2, box.y + box.height / 2]

const strokeOf = (element: object): Stroke => {
  const style = str(element, "strokeStyle")
  return {
    color: safeColor(str(element, "strokeColor"), INK),
    width: num(element, "strokeWidth") ?? 2,
    style: style === "dashed" || style === "dotted" ? style : "solid",
    opacity: (num(element, "opacity") ?? 100) / 100,
  }
}

const textSize = (text: string, fontSize: number) => {
  const lines = text.split("\n")
  return {
    width: Math.max(...lines.map((line) => line.length)) * fontSize * 0.6,
    height: lines.length * fontSize * LINE_HEIGHT,
  }
}

const shapeBox = (element: WhiteboardElement): Box => {
  const label = obj(element, "label")
  const text = label === undefined ? "" : (str(label, "text") ?? "")
  const fits = textSize(text, (label && num(label, "fontSize")) ?? FONT_SIZE)
  return {
    x: num(element, "x") ?? 0,
    y: num(element, "y") ?? 0,
    width: num(element, "width") ?? Math.max(SHAPE_SIZE, fits.width + 40),
    height: num(element, "height") ?? Math.max(SHAPE_SIZE, fits.height + 40),
  }
}

const edgeToward = (shape: ShapeKind, box: Box, target: Point): Point => {
  const [cx, cy] = center(box)
  const dx = target[0] - cx
  const dy = target[1] - cy
  if (dx === 0 && dy === 0) return [cx, cy]
  const hw = box.width / 2
  const hh = box.height / 2
  const scale =
    shape === "ellipse"
      ? 1 / Math.hypot(dx / hw, dy / hh)
      : shape === "diamond"
        ? 1 / (Math.abs(dx) / hw + Math.abs(dy) / hh)
        : Math.min(dx === 0 ? Infinity : hw / Math.abs(dx), dy === 0 ? Infinity : hh / Math.abs(dy))
  return [cx + dx * scale, cy + dy * scale]
}

const bindingId = (element: WhiteboardElement, end: "start" | "end") => {
  const skeleton = obj(element, end)
  const full = obj(element, `${end}Binding`)
  return (skeleton && str(skeleton, "id")) ?? (full && str(full, "elementId"))
}

const midpoint = (points: readonly Point[]): Point => {
  const a = points[Math.floor((points.length - 1) / 2)]!
  const b = points[Math.ceil((points.length - 1) / 2)]!
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]
}

type Shapes = ReadonlyMap<string, { readonly shape: ShapeKind; readonly box: Box }>

const linearPoints = (element: WhiteboardElement, shapes: Shapes): Point[] => {
  const x = num(element, "x") ?? 0
  const y = num(element, "y") ?? 0
  const raw = field(element, "points")
  const relative: Point[] = Array.isArray(raw)
    ? raw.flatMap((point): Point[] =>
        Array.isArray(point) && typeof point[0] === "number" && typeof point[1] === "number"
          ? [[point[0], point[1]]]
          : [],
      )
    : [
        [0, 0],
        [num(element, "width") ?? SHAPE_SIZE, num(element, "height") ?? 0],
      ]
  const points = relative.map(([px, py]): Point => [x + px, y + py])
  if (!isSkeleton(element) || points.length < 2) return points
  const start = shapes.get(bindingId(element, "start") ?? "")
  const end = shapes.get(bindingId(element, "end") ?? "")
  const last = points.length - 1
  const startTarget = end === undefined ? points[1]! : center(end.box)
  const endTarget = start === undefined ? points[last - 1]! : center(start.box)
  if (start !== undefined) points[0] = edgeToward(start.shape, start.box, last === 1 ? startTarget : points[1]!)
  if (end !== undefined) points[last] = edgeToward(end.shape, end.box, last === 1 ? endTarget : points[last - 1]!)
  return points
}

const labelMark = (label: object | undefined, box: Box, fallback: Stroke, backdrop: boolean): Mark[] => {
  const text = label && str(label, "text")
  if (text === undefined || text === "" || label === undefined) return []
  return [
    {
      kind: "text",
      box,
      text,
      fontSize: num(label, "fontSize") ?? FONT_SIZE,
      color: safeColor(str(label, "strokeColor"), fallback.color),
      align: "center",
      middle: true,
      wrap: true,
      backdrop,
      opacity: fallback.opacity,
      angle: 0,
    },
  ]
}

const textMark = (element: WhiteboardElement): Mark => {
  const text = str(element, "text") ?? ""
  const fontSize = num(element, "fontSize") ?? FONT_SIZE
  const fits = textSize(text, fontSize)
  const align = str(element, "textAlign")
  return {
    kind: "text",
    box: {
      x: num(element, "x") ?? 0,
      y: num(element, "y") ?? 0,
      width: num(element, "width") ?? fits.width,
      height: num(element, "height") ?? fits.height,
    },
    text,
    fontSize,
    color: safeColor(str(element, "strokeColor"), INK),
    align: align === "center" || align === "right" ? align : "left",
    middle: str(element, "verticalAlign") === "middle",
    wrap: false,
    backdrop: false,
    opacity: (num(element, "opacity") ?? 100) / 100,
    angle: num(element, "angle") ?? 0,
  }
}

const isShape = (type: string | undefined): type is ShapeKind =>
  type === "rectangle" || type === "ellipse" || type === "diamond"

const marksOf = (element: WhiteboardElement, shapes: Shapes, files: Record<string, unknown>): Mark[] => {
  const type = str(element, "type")
  if (isShape(type)) {
    const box = shapes.get(element.id)!.box
    const stroke = strokeOf(element)
    return [
      {
        kind: "shape",
        shape: type,
        box,
        stroke,
        fill: fillOf(element),
        rounded: field(element, "roundness") !== null,
        angle: num(element, "angle") ?? 0,
      },
      ...labelMark(obj(element, "label"), box, stroke, false),
    ]
  }
  if (type === "arrow" || type === "line" || type === "freedraw") {
    const points = linearPoints(element, shapes)
    if (points.length < 2) return []
    const stroke = strokeOf(element)
    const arrow = type === "arrow"
    const closed = type === "line" && field(element, "polygon") === true
    const [mx, my] = midpoint(points)
    const around = { x: mx - 100, y: my - 40, width: 200, height: 80 }
    return [
      {
        kind: "path",
        points,
        stroke,
        fill: closed ? fillOf(element) : null,
        arrowheads: {
          start: arrow && field(element, "startArrowhead") != null,
          end:
            arrow &&
            (isSkeleton(element) ? field(element, "endArrowhead") !== null : field(element, "endArrowhead") != null),
        },
      },
      ...labelMark(obj(element, "label"), around, stroke, true),
    ]
  }
  if (type === "text") return [textMark(element)]
  if (type === "image") {
    const file = obj(files, str(element, "fileId") ?? "")
    const href = file && str(file, "dataURL")
    if (href === undefined || !href.startsWith("data:image/")) return []
    return [{ kind: "image", box: shapeBox(element), href, angle: num(element, "angle") ?? 0 }]
  }
  return []
}

const extent = (mark: Mark): Box => {
  if (mark.kind !== "path") return mark.box
  const xs = mark.points.map(([x]) => x)
  const ys = mark.points.map(([, y]) => y)
  const x = Math.min(...xs)
  const y = Math.min(...ys)
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y }
}

const union = (boxes: readonly Box[], padding: number): Box => {
  const x = Math.min(...boxes.map((box) => box.x)) - padding
  const y = Math.min(...boxes.map((box) => box.y)) - padding
  const right = Math.max(...boxes.map((box) => box.x + box.width)) + padding
  const bottom = Math.max(...boxes.map((box) => box.y + box.height)) + padding
  return { x, y, width: right - x, height: bottom - y }
}

const frameMark = (element: WhiteboardElement, marksById: ReadonlyMap<string, readonly Mark[]>): Mark | null => {
  const name = str(element, "name") ?? ""
  const width = num(element, "width")
  const height = num(element, "height")
  if (width !== undefined && height !== undefined) {
    return { kind: "frame", box: { x: num(element, "x") ?? 0, y: num(element, "y") ?? 0, width, height }, name }
  }
  const children = field(element, "children")
  const inside = (Array.isArray(children) ? children : []).flatMap((id) =>
    typeof id === "string" ? (marksById.get(id) ?? []) : [],
  )
  return inside.length === 0 ? null : { kind: "frame", box: union(inside.map(extent), FRAME_PADDING), name }
}

export function drawWhiteboard(scene: WhiteboardScene): Drawing | null {
  const live = scene.elements.filter((element) => field(element, "isDeleted") !== true)
  const shapes: Shapes = new Map(
    live.flatMap((element) => {
      const type = str(element, "type")
      return isShape(type) ? [[element.id, { shape: type, box: shapeBox(element) }] as const] : []
    }),
  )
  const marksById = new Map(live.map((element) => [element.id, marksOf(element, shapes, scene.files ?? {})] as const))
  const frames = live.flatMap((element) => {
    const type = str(element, "type")
    const frame = type === "frame" || type === "magicframe" ? frameMark(element, marksById) : null
    return frame === null ? [] : [frame]
  })
  const marks = [...frames, ...[...marksById.values()].flat()]
  if (marks.length === 0) return null
  return { marks, bounds: union(marks.map(extent), PAGE_PADDING) }
}

const ENTITIES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }
const escape = (value: string) => value.replace(/[&<>"']/g, (char) => ENTITIES[char]!)

const rotate = (angle: number, box: Box) => {
  if (angle === 0) return ""
  const [cx, cy] = center(box)
  return ` transform="rotate(${(angle * 180) / Math.PI} ${cx} ${cy})"`
}

const strokeAttributes = ({ color, width, style, opacity }: Stroke) => {
  const dash =
    style === "dashed"
      ? ` stroke-dasharray="${width * 4} ${width * 3}"`
      : style === "dotted"
        ? ` stroke-dasharray="${width} ${width * 2.5}"`
        : ""
  return `stroke="${escape(color)}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round" opacity="${opacity}"${dash}`
}

const fillAttribute = (fill: string | null) => `fill="${fill === null ? "none" : escape(fill)}"`

const arrowhead = (tip: Point, from: Point, stroke: Stroke) => {
  const angle = Math.atan2(tip[1] - from[1], tip[0] - from[0])
  const size = ARROWHEAD + stroke.width * 2
  const wing = (offset: number): Point => [
    tip[0] - size * Math.cos(angle + offset),
    tip[1] - size * Math.sin(angle + offset),
  ]
  const [a, b] = [wing(Math.PI / 7), wing(-Math.PI / 7)]
  return `<path d="M${a[0]} ${a[1]}L${tip[0]} ${tip[1]}L${b[0]} ${b[1]}" fill="none" ${strokeAttributes({ ...stroke, style: "solid" })}/>`
}

const shapeSvg = (mark: Extract<Mark, { kind: "shape" }>) => {
  const { x, y, width, height } = mark.box
  const paint = `${fillAttribute(mark.fill)} ${strokeAttributes(mark.stroke)}${rotate(mark.angle, mark.box)}`
  if (mark.shape === "ellipse") {
    return `<ellipse cx="${x + width / 2}" cy="${y + height / 2}" rx="${width / 2}" ry="${height / 2}" ${paint}/>`
  }
  if (mark.shape === "diamond") {
    return `<path d="M${x + width / 2} ${y}L${x + width} ${y + height / 2}L${x + width / 2} ${y + height}L${x} ${y + height / 2}Z" ${paint}/>`
  }
  const corner = mark.rounded ? Math.min(32, Math.min(width, height) * 0.25) : 0
  return `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="${corner}" ${paint}/>`
}

const textSvg = (mark: Extract<Mark, { kind: "text" }>) => {
  const { x, y, width, height } = mark.box
  const style = [
    "width:100%",
    "height:100%",
    "display:flex",
    `flex-direction:column`,
    `justify-content:${mark.middle ? "center" : "flex-start"}`,
    `align-items:${FLEX_ALIGN[mark.align]}`,
    `text-align:${mark.align}`,
    `font:${mark.fontSize}px/${LINE_HEIGHT} system-ui,-apple-system,sans-serif`,
    `color:${escape(mark.color)}`,
    `opacity:${mark.opacity}`,
    `white-space:${mark.wrap ? "pre-wrap" : "pre"}`,
    "overflow-wrap:anywhere",
    mark.wrap ? "padding:0 8px;box-sizing:border-box" : "",
  ].join(";")
  const inner = mark.backdrop
    ? `<span style="background:${CANVAS.light};padding:0 4px">${escape(mark.text)}</span>`
    : escape(mark.text)
  return `<foreignObject x="${x}" y="${y}" width="${width}" height="${height}" overflow="visible"${rotate(mark.angle, mark.box)}><div xmlns="http://www.w3.org/1999/xhtml" style="${style}">${inner}</div></foreignObject>`
}

const markSvg = (mark: Mark) => {
  switch (mark.kind) {
    case "shape":
      return shapeSvg(mark)
    case "text":
      return textSvg(mark)
    case "path": {
      const d = mark.points.map(([x, y], index) => `${index === 0 ? "M" : "L"}${x} ${y}`).join("")
      const last = mark.points.length - 1
      return [
        `<path d="${d}${mark.fill === null ? "" : "Z"}" ${fillAttribute(mark.fill)} ${strokeAttributes(mark.stroke)}/>`,
        mark.arrowheads.start ? arrowhead(mark.points[0]!, mark.points[1]!, mark.stroke) : "",
        mark.arrowheads.end ? arrowhead(mark.points[last]!, mark.points[last - 1]!, mark.stroke) : "",
      ].join("")
    }
    case "image": {
      const { x, y, width, height } = mark.box
      return `<image class="photo" x="${x}" y="${y}" width="${width}" height="${height}" href="${escape(mark.href)}"${rotate(mark.angle, mark.box)}/>`
    }
    case "frame": {
      const { x, y, width, height } = mark.box
      return `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="8" fill="none" stroke="#bbb" stroke-width="1"/><text x="${x}" y="${y - 8}" font-size="14" font-family="system-ui,sans-serif" fill="#888">${escape(mark.name)}</text>`
    }
  }
}

export function whiteboardHtml(drawing: Drawing, scheme: "light" | "dark") {
  const { x, y, width, height } = drawing.bounds
  const css = [
    `html,body{margin:0;height:100%;background:${CANVAS[scheme]}}`,
    "svg{display:block;width:100vw;height:100vh}",
    scheme === "dark"
      ? "svg{filter:invert(93%) hue-rotate(180deg)}svg .photo{filter:invert(100%) hue-rotate(180deg)}"
      : "",
  ].join("")
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'"><style>${css}</style></head><body><svg xmlns="http://www.w3.org/2000/svg" viewBox="${x} ${y} ${width} ${height}">${drawing.marks.map(markSvg).join("")}</svg></body></html>`
}
