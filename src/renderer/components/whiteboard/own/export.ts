import {
  arrowBounds,
  arrowGeometry,
  boundsOf,
  byIdOf,
  charactersPerLine,
  isArrow,
  LABEL_FONT_SIZE,
  LABEL_LINE_HEIGHT,
  labelTextOf,
  TEXT_FONT_SIZE,
  unionBounds,
  wrapText,
  type Bounds,
  type OwnElement,
} from "./elements.ts"

export type ExportTheme = {
  readonly background: string
  readonly foreground: string
  readonly muted: string
  readonly mutedForeground: string
}

const PADDING = 24

const escapeXml = (value: string) =>
  value.replace(/[&<>"']/g, (character) =>
    character === "&"
      ? "&amp;"
      : character === "<"
        ? "&lt;"
        : character === ">"
          ? "&gt;"
          : character === '"'
            ? "&quot;"
            : "&#39;",
  )

const arrowHead = (x1: number, y1: number, x2: number, y2: number, color: string) => {
  const angle = Math.atan2(y2 - y1, x2 - x1)
  const size = 12
  const wing = Math.PI / 7
  const ax = x2 - size * Math.cos(angle - wing)
  const ay = y2 - size * Math.sin(angle - wing)
  const bx = x2 - size * Math.cos(angle + wing)
  const by = y2 - size * Math.sin(angle + wing)
  return `<path d="M ${x2} ${y2} L ${ax} ${ay} L ${bx} ${by} Z" fill="${color}" />`
}

const textLines = (element: OwnElement, width: number, fontSize: number) =>
  wrapText(labelTextOf(element), charactersPerLine(width, fontSize))

const centerText = (element: OwnElement, bounds: Bounds, theme: ExportTheme) => {
  const lines = textLines(element, bounds.width, LABEL_FONT_SIZE)
  const startY = bounds.y + bounds.height / 2 - ((lines.length - 1) * LABEL_LINE_HEIGHT) / 2
  const centerX = bounds.x + bounds.width / 2
  return lines
    .map(
      (line, index) =>
        `<text x="${centerX}" y="${startY + index * LABEL_LINE_HEIGHT}" text-anchor="middle" dominant-baseline="central" font-family="sans-serif" font-size="${LABEL_FONT_SIZE}" fill="${theme.foreground}">${escapeXml(line)}</text>`,
    )
    .join("")
}

const freeText = (element: OwnElement, bounds: Bounds, theme: ExportTheme) => {
  const lines = textLines(element, bounds.width, TEXT_FONT_SIZE)
  return lines
    .map(
      (line, index) =>
        `<text x="${bounds.x}" y="${bounds.y + index * (TEXT_FONT_SIZE + 6)}" dominant-baseline="hanging" font-family="sans-serif" font-size="${TEXT_FONT_SIZE}" fill="${theme.foreground}">${escapeXml(line)}</text>`,
    )
    .join("")
}

const shapeMarkup = (element: OwnElement, theme: ExportTheme) => {
  const bounds = boundsOf(element)
  const common = `fill="${theme.muted}" stroke="${theme.foreground}" stroke-width="2"`
  const body =
    element.type === "ellipse"
      ? `<ellipse cx="${bounds.x + bounds.width / 2}" cy="${bounds.y + bounds.height / 2}" rx="${bounds.width / 2}" ry="${bounds.height / 2}" ${common} />`
      : element.type === "diamond"
        ? `<polygon points="${bounds.x + bounds.width / 2},${bounds.y} ${bounds.x + bounds.width},${bounds.y + bounds.height / 2} ${bounds.x + bounds.width / 2},${bounds.y + bounds.height} ${bounds.x},${bounds.y + bounds.height / 2}" ${common} />`
        : `<rect x="${bounds.x}" y="${bounds.y}" width="${bounds.width}" height="${bounds.height}" rx="6" ${common} />`
  const label = element.label === undefined ? "" : centerText(element, bounds, theme)
  return body + label
}

const arrowMarkup = (element: OwnElement, byId: ReadonlyMap<string, OwnElement>, theme: ExportTheme) => {
  const { x1, y1, x2, y2 } = arrowGeometry(element, byId)
  const head = element.type === "arrow" ? arrowHead(x1, y1, x2, y2, theme.mutedForeground) : ""
  const line = `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${theme.mutedForeground}" stroke-width="2" stroke-linecap="round" />`
  const label =
    element.label === undefined
      ? ""
      : `<text x="${(x1 + x2) / 2}" y="${(y1 + y2) / 2 - 6}" text-anchor="middle" font-family="sans-serif" font-size="${LABEL_FONT_SIZE}" fill="${theme.mutedForeground}">${escapeXml(element.label.text)}</text>`
  return line + head + label
}

export const elementsSvg = (
  elements: ReadonlyArray<OwnElement>,
  ids: ReadonlyArray<string>,
  theme: ExportTheme,
): string => {
  const wanted = new Set(ids)
  const byId = byIdOf(elements)
  const chosen = elements.filter(
    (element) =>
      element.isDeleted !== true &&
      (wanted.has(element.id) || (element.containerId != null && wanted.has(element.containerId))),
  )
  const region = unionBounds(
    chosen.map((element) => (isArrow(element) ? arrowBounds(element, byId) : boundsOf(element))),
  ) ?? {
    x: 0,
    y: 0,
    width: 1,
    height: 1,
  }
  const viewBox = `${region.x - PADDING} ${region.y - PADDING} ${region.width + PADDING * 2} ${region.height + PADDING * 2}`
  const arrows = chosen.filter(isArrow).map((element) => arrowMarkup(element, byId, theme))
  const shapes = chosen
    .filter((element) => !isArrow(element) && element.type !== "text")
    .map((element) => shapeMarkup(element, theme))
  const texts = chosen
    .filter((element) => element.type === "text")
    .map((element) => freeText(element, boundsOf(element), theme))
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" width="${region.width + PADDING * 2}" height="${region.height + PADDING * 2}"><rect x="${region.x - PADDING}" y="${region.y - PADDING}" width="${region.width + PADDING * 2}" height="${region.height + PADDING * 2}" fill="${theme.background}" />${arrows.join("")}${shapes.join("")}${texts.join("")}</svg>`
}

export const exportElementsPng = async (
  elements: ReadonlyArray<OwnElement>,
  ids: ReadonlyArray<string>,
  theme: ExportTheme,
): Promise<Blob> => {
  const svg = elementsSvg(elements, ids, theme)
  const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
  const image = new Image()
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve()
    image.onerror = () => reject(new Error("Could not render the whiteboard selection."))
    image.src = url
  })
  const scale = 2
  const canvas = document.createElement("canvas")
  canvas.width = Math.max(1, Math.round((image.naturalWidth || 1) * scale))
  canvas.height = Math.max(1, Math.round((image.naturalHeight || 1) * scale))
  const context = canvas.getContext("2d")
  if (context === null) throw new Error("Could not render the whiteboard selection.")
  context.drawImage(image, 0, 0, canvas.width, canvas.height)
  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob === null ? reject(new Error("Could not render the whiteboard selection.")) : resolve(blob)),
      "image/png",
    )
  })
}
