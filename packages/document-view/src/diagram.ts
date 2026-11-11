import type { DiagramDrawing, DiagramPaint, DiagramShape } from "./blocks.ts"
import { DIAGRAM_PATH as PATH } from "./protocol.ts"

type Matrix = readonly [number, number, number, number, number, number]

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0]

const multiply = ([a, b, c, d, e, f]: Matrix, [g, h, i, j, k, l]: Matrix): Matrix => [
  a * g + c * h,
  b * g + d * h,
  a * i + c * j,
  b * i + d * j,
  a * k + c * l + e,
  b * k + d * l + f,
]

const numbers = (text: string) => (text.match(/-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi) ?? []).map(Number)

function parseTransform(text: string | undefined): Matrix {
  let matrix = IDENTITY
  for (const [, name, args] of (text ?? "").matchAll(/(\w+)\s*\(([^)]*)\)/g)) {
    const [p = 0, q, r] = numbers(args ?? "")
    if (name === "translate") matrix = multiply(matrix, [1, 0, 0, 1, p, q ?? 0])
    else if (name === "scale") matrix = multiply(matrix, [p, 0, 0, q ?? p, 0, 0])
    else if (name === "rotate") {
      const angle = (p * Math.PI) / 180
      const [cos, sin] = [Math.cos(angle), Math.sin(angle)]
      const [cx, cy] = [q ?? 0, r ?? 0]
      matrix = multiply(matrix, [1, 0, 0, 1, cx, cy])
      matrix = multiply(matrix, [cos, sin, -sin, cos, 0, 0])
      matrix = multiply(matrix, [1, 0, 0, 1, -cx, -cy])
    } else if (name === "matrix") {
      const all = numbers(args ?? "")
      if (all.length === 6) matrix = multiply(matrix, all as unknown as Matrix)
    }
  }
  return matrix
}

const ROLES: Readonly<Record<string, DiagramPaint>> = {
  "--_bg": "@bg",
  "--_fg": "@fg",
  "--_m": "@muted",
  "--_l": "@line",
  "--_s": "@surface",
  "--_a": "@surfaceAlt",
  "--_b": "@border",
  "--_c": "@accent",
  "--_k": "@critical",
}

function paint(value: string | undefined): DiagramPaint | null | undefined {
  if (value === undefined) return undefined
  const trimmed = value.trim()
  if (trimmed === "none" || trimmed === "transparent") return null
  if (trimmed === "currentColor") return "@fg"
  const variable = /^var\(\s*(--[\w-]+)\s*(?:,\s*([^)]+))?\)$/.exec(trimmed)
  if (variable === null) return trimmed
  return ROLES[variable[1]!] ?? (variable[2] === undefined ? "@fg" : paint(variable[2]))
}

type Style = {
  readonly fill: DiagramPaint | null
  readonly stroke: DiagramPaint | null
  readonly width: number
  readonly dash: ReadonlyArray<number> | null
  readonly opacity: number
  readonly size: number
  readonly weight: number
  readonly anchor: "start" | "middle" | "end"
  readonly matrix: Matrix
}

const ROOT_STYLE: Style = {
  fill: "@fg",
  stroke: null,
  width: 1,
  dash: null,
  opacity: 1,
  size: 12,
  weight: 400,
  anchor: "start",
  matrix: IDENTITY,
}

type Attributes = Readonly<Record<string, string>>

const attributesOf = (text: string): Attributes => {
  const attributes: Record<string, string> = {}
  for (const [, name, value] of text.matchAll(/([\w:-]+)\s*=\s*"([^"]*)"/g)) attributes[name!] = decodeEntities(value!)
  for (const declaration of (attributes["style"] ?? "").split(";")) {
    const [name, ...rest] = declaration.split(":")
    const key = name?.trim()
    if (key !== undefined && /^(fill|stroke|stroke-width|font-size|font-weight)$/.test(key))
      attributes[key] = rest.join(":").trim()
  }
  return attributes
}

const decodeEntities = (text: string) =>
  text.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, entity: string) => {
    if (entity[0] === "#")
      return String.fromCodePoint(
        entity[1] === "x" || entity[1] === "X" ? parseInt(entity.slice(2), 16) : Number(entity.slice(1)),
      )
    return { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }[entity.toLowerCase()] ?? ""
  })

const weightOf = (value: string | undefined, inherited: number) => {
  if (value === undefined) return inherited
  if (value === "bold" || value === "bolder") return 700
  if (value === "normal") return 400
  const number = Number(value)
  return Number.isFinite(number) ? number : inherited
}

function inherit(parent: Style, attributes: Attributes): Style {
  const fill = paint(attributes["fill"])
  const stroke = paint(attributes["stroke"])
  const dash = attributes["stroke-dasharray"]
  const anchor = attributes["text-anchor"]
  return {
    fill: fill === undefined ? parent.fill : fill,
    stroke: stroke === undefined ? parent.stroke : stroke,
    width: attributes["stroke-width"] === undefined ? parent.width : Number.parseFloat(attributes["stroke-width"]),
    dash: dash === undefined ? parent.dash : dash === "none" ? null : numbers(dash),
    opacity: parent.opacity * Number(attributes["fill-opacity"] ?? attributes["opacity"] ?? 1),
    size: attributes["font-size"] === undefined ? parent.size : Number.parseFloat(attributes["font-size"]),
    weight: weightOf(attributes["font-weight"], parent.weight),
    anchor: anchor === "middle" || anchor === "end" || anchor === "start" ? anchor : parent.anchor,
    matrix:
      attributes["transform"] === undefined
        ? parent.matrix
        : multiply(parent.matrix, parseTransform(attributes["transform"])),
  }
}

class PathBuilder {
  readonly data: number[] = []
  constructor(private readonly matrix: Matrix) {}
  private point(x: number, y: number) {
    const [a, b, c, d, e, f] = this.matrix
    this.data.push(a * x + c * y + e, b * x + d * y + f)
  }
  move(x: number, y: number) {
    this.data.push(PATH.move)
    this.point(x, y)
  }
  line(x: number, y: number) {
    this.data.push(PATH.line)
    this.point(x, y)
  }
  cubic(x1: number, y1: number, x2: number, y2: number, x: number, y: number) {
    this.data.push(PATH.cubic)
    this.point(x1, y1)
    this.point(x2, y2)
    this.point(x, y)
  }
  close() {
    this.data.push(PATH.close)
  }
}

const vectorAngle = (ux: number, uy: number, vx: number, vy: number) => {
  const dot = ux * vx + uy * vy
  const length = Math.hypot(ux, uy) * Math.hypot(vx, vy)
  const value = Math.acos(Math.max(-1, Math.min(1, dot / length)))
  return ux * vy - uy * vx < 0 ? -value : value
}

function arcToCubics(
  path: PathBuilder,
  from: readonly [number, number],
  radii: readonly [number, number],
  rotation: number,
  large: boolean,
  sweep: boolean,
  to: readonly [number, number],
) {
  let [rx, ry] = [Math.abs(radii[0]), Math.abs(radii[1])]
  const [x1, y1] = from
  const [x2, y2] = to
  if (rx === 0 || ry === 0 || (x1 === x2 && y1 === y2)) return path.line(x2, y2)
  const phi = (rotation * Math.PI) / 180
  const [cos, sin] = [Math.cos(phi), Math.sin(phi)]
  const dx = (x1 - x2) / 2
  const dy = (y1 - y2) / 2
  const xp = cos * dx + sin * dy
  const yp = -sin * dx + cos * dy
  const lambda = (xp * xp) / (rx * rx) + (yp * yp) / (ry * ry)
  if (lambda > 1) {
    rx *= Math.sqrt(lambda)
    ry *= Math.sqrt(lambda)
  }
  const sign = large === sweep ? -1 : 1
  const numerator = rx * rx * ry * ry - rx * rx * yp * yp - ry * ry * xp * xp
  const factor = sign * Math.sqrt(Math.max(0, numerator / (rx * rx * yp * yp + ry * ry * xp * xp)))
  const cxp = (factor * rx * yp) / ry
  const cyp = (-factor * ry * xp) / rx
  const cx = cos * cxp - sin * cyp + (x1 + x2) / 2
  const cy = sin * cxp + cos * cyp + (y1 + y2) / 2
  const start = vectorAngle(1, 0, (xp - cxp) / rx, (yp - cyp) / ry)
  let delta = vectorAngle((xp - cxp) / rx, (yp - cyp) / ry, (-xp - cxp) / rx, (-yp - cyp) / ry)
  if (!sweep && delta > 0) delta -= 2 * Math.PI
  if (sweep && delta < 0) delta += 2 * Math.PI
  const segments = Math.ceil(Math.abs(delta) / (Math.PI / 2))
  const step = delta / segments
  const handle = (4 / 3) * Math.tan(step / 4)
  const at = (theta: number) =>
    [
      cx + rx * Math.cos(theta) * cos - ry * Math.sin(theta) * sin,
      cy + rx * Math.cos(theta) * sin + ry * Math.sin(theta) * cos,
    ] as const
  const tangent = (theta: number) =>
    [
      -rx * Math.sin(theta) * cos - ry * Math.cos(theta) * sin,
      -rx * Math.sin(theta) * sin + ry * Math.cos(theta) * cos,
    ] as const
  for (let index = 0; index < segments; index++) {
    const a = start + index * step
    const b = a + step
    const [ax, ay] = at(a)
    const [bx, by] = at(b)
    const [tax, tay] = tangent(a)
    const [tbx, tby] = tangent(b)
    path.cubic(ax + handle * tax, ay + handle * tay, bx - handle * tbx, by - handle * tby, bx, by)
  }
}

function tracePath(path: PathBuilder, d: string) {
  const tokens = d.match(/[a-df-z]|-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi) ?? []
  let index = 0
  let [x, y, startX, startY] = [0, 0, 0, 0]
  let [lastControlX, lastControlY] = [0, 0]
  let previous = ""
  let command = ""
  const next = () => Number(tokens[index++])
  while (index < tokens.length) {
    if (/[a-z]/i.test(tokens[index]!)) command = tokens[index++]!
    else if (command === "") return
    const relative = command === command.toLowerCase()
    const ox = relative ? x : 0
    const oy = relative ? y : 0
    switch (command.toUpperCase()) {
      case "M":
        x = ox + next()
        y = oy + next()
        ;[startX, startY] = [x, y]
        path.move(x, y)
        command = relative ? "l" : "L"
        break
      case "L":
        x = ox + next()
        y = oy + next()
        path.line(x, y)
        break
      case "H":
        x = ox + next()
        path.line(x, y)
        break
      case "V":
        y = oy + next()
        path.line(x, y)
        break
      case "C": {
        const [x1, y1, x2, y2] = [ox + next(), oy + next(), ox + next(), oy + next()]
        x = ox + next()
        y = oy + next()
        path.cubic(x1, y1, x2, y2, x, y)
        ;[lastControlX, lastControlY] = [x2, y2]
        break
      }
      case "S": {
        const smooth = /[CS]/i.test(previous)
        const [x1, y1] = smooth ? [2 * x - lastControlX, 2 * y - lastControlY] : [x, y]
        const [x2, y2] = [ox + next(), oy + next()]
        x = ox + next()
        y = oy + next()
        path.cubic(x1, y1, x2, y2, x, y)
        ;[lastControlX, lastControlY] = [x2, y2]
        break
      }
      case "Q":
      case "T": {
        const smooth = command.toUpperCase() === "T"
        const [qx, qy] = smooth
          ? /[QT]/i.test(previous)
            ? [2 * x - lastControlX, 2 * y - lastControlY]
            : [x, y]
          : [ox + next(), oy + next()]
        const [ex, ey] = [ox + next(), oy + next()]
        path.cubic(
          x + (2 / 3) * (qx - x),
          y + (2 / 3) * (qy - y),
          ex + (2 / 3) * (qx - ex),
          ey + (2 / 3) * (qy - ey),
          ex,
          ey,
        )
        ;[lastControlX, lastControlY, x, y] = [qx, qy, ex, ey]
        break
      }
      case "A": {
        const [rx, ry, rotation, large, sweep] = [next(), next(), next(), next(), next()]
        const to = [ox + next(), oy + next()] as const
        arcToCubics(path, [x, y], [rx, ry], rotation, large !== 0, sweep !== 0, to)
        ;[x, y] = to
        break
      }
      case "Z":
        path.close()
        ;[x, y] = [startX, startY]
        break
      default:
        return
    }
    previous = command
  }
}

const KAPPA = 0.5522847498

function traceEllipse(path: PathBuilder, cx: number, cy: number, rx: number, ry: number) {
  const [kx, ky] = [rx * KAPPA, ry * KAPPA]
  path.move(cx + rx, cy)
  path.cubic(cx + rx, cy + ky, cx + kx, cy + ry, cx, cy + ry)
  path.cubic(cx - kx, cy + ry, cx - rx, cy + ky, cx - rx, cy)
  path.cubic(cx - rx, cy - ky, cx - kx, cy - ry, cx, cy - ry)
  path.cubic(cx + kx, cy - ry, cx + rx, cy - ky, cx + rx, cy)
  path.close()
}

function traceRect(path: PathBuilder, x: number, y: number, width: number, height: number, radius: number) {
  const r = Math.min(radius, width / 2, height / 2)
  if (r <= 0) {
    path.move(x, y)
    path.line(x + width, y)
    path.line(x + width, y + height)
    path.line(x, y + height)
    path.close()
    return
  }
  const k = r * (1 - KAPPA)
  path.move(x + r, y)
  path.line(x + width - r, y)
  path.cubic(x + width - k, y, x + width, y + k, x + width, y + r)
  path.line(x + width, y + height - r)
  path.cubic(x + width, y + height - k, x + width - k, y + height, x + width - r, y + height)
  path.line(x + r, y + height)
  path.cubic(x + k, y + height, x, y + height - k, x, y + height - r)
  path.line(x, y + r)
  path.cubic(x, y + k, x + k, y, x + r, y)
  path.close()
}

const num = (attributes: Attributes, name: string) => Number.parseFloat(attributes[name] ?? "0") || 0

function shapePath(name: string, attributes: Attributes, matrix: Matrix): number[] | null {
  const path = new PathBuilder(matrix)
  switch (name) {
    case "path":
      tracePath(path, attributes["d"] ?? "")
      break
    case "rect":
      traceRect(
        path,
        num(attributes, "x"),
        num(attributes, "y"),
        num(attributes, "width"),
        num(attributes, "height"),
        num(attributes, "rx") || num(attributes, "ry"),
      )
      break
    case "circle":
      traceEllipse(path, num(attributes, "cx"), num(attributes, "cy"), num(attributes, "r"), num(attributes, "r"))
      break
    case "ellipse":
      traceEllipse(path, num(attributes, "cx"), num(attributes, "cy"), num(attributes, "rx"), num(attributes, "ry"))
      break
    case "line":
      path.move(num(attributes, "x1"), num(attributes, "y1"))
      path.line(num(attributes, "x2"), num(attributes, "y2"))
      break
    case "polygon":
    case "polyline": {
      const points = numbers(attributes["points"] ?? "")
      for (let index = 0; index + 1 < points.length; index += 2)
        if (index === 0) path.move(points[0]!, points[1]!)
        else path.line(points[index]!, points[index + 1]!)
      if (name === "polygon") path.close()
      break
    }
    default:
      return null
  }
  return path.data.length === 0 ? null : path.data
}

const scaleOf = ([a, b, c, d]: Matrix) => Math.sqrt(Math.abs(a * d - b * c)) || 1

const SKIPPED = new Set(["title", "desc", "defs", "style", "metadata", "clipPath", "mask", "marker", "linearGradient"])

export function svgToDrawing(svg: string): DiagramDrawing | null {
  const root = /<svg\b([^>]*)>/.exec(svg)
  if (root === null) return null
  const rootAttributes = attributesOf(root[1]!)
  const box = numbers(rootAttributes["viewBox"] ?? "")
  const width = box[2] ?? num(rootAttributes, "width")
  const height = box[3] ?? num(rootAttributes, "height")
  if (!(width > 0 && height > 0)) return null
  const origin: Matrix = [1, 0, 0, 1, -(box[0] ?? 0), -(box[1] ?? 0)]
  const shapes: DiagramShape[] = []
  const stack: { readonly name: string; readonly style: Style }[] = [
    { name: "svg", style: { ...inherit(ROOT_STYLE, rootAttributes), matrix: origin } },
  ]
  let skipping = 0
  let text: { x: number; y: number; style: Style; parts: string[] } | null = null
  let textBase: Style | null = null

  const flushText = () => {
    if (text === null) return
    const content = text.parts.join("").replace(/\s+/g, " ").trim()
    const [a, b, c, d, e, f] = text.style.matrix
    if (content !== "" && text.style.fill !== null)
      shapes.push({
        kind: "text",
        text: content,
        x: a * text.x + c * text.y + e,
        y: b * text.x + d * text.y + f,
        anchor: text.style.anchor,
        size: text.style.size * scaleOf(text.style.matrix),
        weight: text.style.weight,
        fill: text.style.fill,
      })
    text.parts = []
  }

  const body = svg.slice(root.index + root[0].length)
  for (const [, closing, name, attributeText, selfClosing, content] of body.matchAll(
    /<(\/?)([a-zA-Z][\w:-]*)([^>]*?)(\/?)>|([^<]+)/g,
  )) {
    if (content !== undefined) {
      if (skipping === 0 && text !== null) text.parts.push(decodeEntities(content))
      continue
    }
    if (name === undefined) continue
    if (closing === "/") {
      if (SKIPPED.has(name)) skipping = Math.max(0, skipping - 1)
      if (skipping > 0) continue
      if (name === "text") {
        flushText()
        text = null
        textBase = null
      } else if (name === "tspan") flushText()
      if (name !== "svg" && stack.length > 1 && stack.at(-1)!.name === name) stack.pop()
      continue
    }
    if (SKIPPED.has(name)) {
      if (selfClosing !== "/") skipping++
      continue
    }
    if (skipping > 0) continue
    const attributes = attributesOf(attributeText ?? "")
    const style = inherit(name === "tspan" && textBase !== null ? textBase : stack.at(-1)!.style, attributes)
    if (name === "text") textBase = style
    if (name === "text" || name === "tspan") {
      flushText()
      const x: number = attributes["x"] === undefined ? (text?.x ?? 0) : num(attributes, "x")
      const y: number = attributes["y"] === undefined ? (text?.y ?? 0) : num(attributes, "y")
      text = { x, y, style, parts: [] }
    } else {
      const data = shapePath(name, attributes, style.matrix)
      if (data !== null && (style.fill !== null || style.stroke !== null))
        shapes.push({
          kind: "path",
          data,
          fill: name === "line" || name === "polyline" ? null : style.fill,
          stroke: style.stroke,
          width: style.width * scaleOf(style.matrix),
          dash: style.dash,
          opacity: style.opacity,
        })
    }
    if (selfClosing !== "/" && name !== "text" && name !== "tspan") stack.push({ name, style })
  }
  return { width, height, shapes }
}

export async function drawDiagram(source: string): Promise<DiagramDrawing | null> {
  const { renderAsync } = await import("pele/lazy")
  const rendered = (await renderAsync(source, { fontSize: 12, links: false, images: false })) as unknown as
    | { readonly svg: string }
    | string
  return svgToDrawing(typeof rendered === "string" ? rendered : rendered.svg)
}
