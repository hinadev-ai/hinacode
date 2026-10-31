// Draws the HinaCode mark and writes every desktop and site icon from it: `node scripts/logo.ts`.
// The mark is an "H": two pill bars, offset and point-symmetric, around a sun. A ring is cut out of the bars
// around the sun, and small tangent circles round the joints where the ring meets a bar. Every curve is a circle arc.
// The mobile icons are rendered from assets/icon.svg by apps/mobile/scripts/build-app-icons.sh.
import { execFileSync } from "node:child_process"
import { writeFileSync } from "node:fs"

const palette = { coral: "#E56B4F", ink: "#233737", paper: "#F7F7F2", gold: "#EBB13A" }

/** On a 256 grid centred on (128, 128). */
const shape = { barWidth: 64, gap: 52, barHeight: 168, offset: 28, sun: 46, ring: 12, fillet: 5 }
const center = 128
const corner = shape.barWidth / 2
const leftEdge = center - shape.gap / 2 - shape.barWidth
const top = center + shape.offset / 2 - shape.barHeight / 2

// The right bar is the left one turned 180° about the centre, so its top is the mark's top.
const markTop = 2 * center - top - shape.barHeight

type Point = { x: number; y: number }
type Circle = Point & { r: number }
type Step = Point & { r?: number; sweep?: 0 | 1 }

const arc = (p: Point, r: number, sweep: 0 | 1 = 1): Step => ({ ...p, r, sweep })
const round2 = (v: number) => +v.toFixed(2)

function intersect(a: Circle, b: Circle): Point[] {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const d = Math.hypot(dx, dy)
  const along = (d * d + a.r * a.r - b.r * b.r) / (2 * d)
  const h = Math.sqrt(Math.max(0, a.r * a.r - along * along))
  const mx = a.x + (dx * along) / d
  const my = a.y + (dy * along) / d
  return [
    { x: mx + (dy * h) / d, y: my - (dx * h) / d },
    { x: mx - (dy * h) / d, y: my + (dx * h) / d },
  ]
}

const toward = (from: Point, to: Point, r: number): Point => {
  const d = Math.hypot(to.x - from.x, to.y - from.y)
  return { x: from.x + ((to.x - from.x) * r) / d, y: from.y + ((to.y - from.y) * r) / d }
}

/** The SVG elements of the mark, without a fill, so callers pick the colour. */
function mark() {
  const { fillet, sun } = shape
  const innerEdge = center - shape.gap / 2
  const bottom = top + shape.barHeight
  const ring: Circle = { x: center, y: center, r: sun + shape.ring }

  // The fillet circle touches the ring from outside, and the bar's inner edge or, where the edge has already
  // turned into the end cap, the cap from inside. The offset puts the upper joint on a cap and the lower on an edge.
  const joint = (cap: Point, side: 1 | -1) => {
    const edgeY = center + side * Math.sqrt((ring.r + fillet) ** 2 - (innerEdge - fillet - center) ** 2)
    if (side * (edgeY - cap.y) < 0) {
      const filletCenter = { x: innerEdge - fillet, y: edgeY }
      return { bar: { x: innerEdge, y: edgeY }, ring: toward(ring, filletCenter, ring.r), onCap: false }
    }
    const filletCenter = intersect({ ...ring, r: ring.r + fillet }, { ...cap, r: corner - fillet }).find(
      (p) => side * (p.y - cap.y) > 0,
    )
    if (!filletCenter) throw new Error("The fillet circle does not touch the bar's cap")
    return { bar: toward(cap, filletCenter, corner), ring: toward(ring, filletCenter, ring.r), onCap: true }
  }
  const upper = joint({ x: innerEdge - corner, y: top + corner }, -1)
  const lower = joint({ x: innerEdge - corner, y: bottom - corner }, 1)

  const leftBar: Step[] = [
    { x: leftEdge, y: top + corner },
    arc({ x: leftEdge + corner, y: top }, corner),
    ...(upper.onCap ? [arc(upper.bar, corner)] : [arc({ x: innerEdge, y: top + corner }, corner), upper.bar]),
    arc(upper.ring, fillet),
    arc(lower.ring, ring.r, 0),
    arc(lower.bar, fillet),
    ...(lower.onCap ? [] : [{ x: innerEdge, y: bottom - corner }]),
    arc({ x: innerEdge - corner, y: bottom }, corner),
    arc({ x: leftEdge, y: bottom - corner }, corner),
  ]
  const rightBar = leftBar.map((p) => ({ ...p, x: 2 * center - p.x, y: 2 * center - p.y }))
  const path = (steps: Step[]) =>
    steps
      .map((p, i) => {
        if (i === 0) return `M${round2(p.x)} ${round2(p.y)}`
        if (p.r) return `A${round2(p.r)} ${round2(p.r)} 0 0 ${p.sweep} ${round2(p.x)} ${round2(p.y)}`
        return `L${round2(p.x)} ${round2(p.y)}`
      })
      .join("") + "Z"
  return `<path d="${path(leftBar)}${path(rightBar)}"/><circle cx="${center}" cy="${center}" r="${sun}"/>`
}

/** The app icon: a paper mark on a coral tile. The transform fits the 256 grid into the middle 184 units. */
const tile = (markTransform = "translate(36 36) scale(0.71875)", extra = "") =>
  [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256">`,
    `  <rect width="256" height="256" rx="56" fill="${palette.coral}"/>`,
    `  <g fill="${palette.paper}" transform="${markTransform}">${mark()}</g>`,
    ...(extra ? [extra] : []),
    `</svg>`,
    ``,
  ].join("\n")

// The dev icon lifts the mark 16 units to make room for a DEV band, so dev and release builds differ in the Dock.
const devBand = [
  `  <path d="M0 196H256V200A56 56 0 0 1 200 256H56A56 56 0 0 1 0 200Z" fill="${palette.gold}"/>`,
  `  <text x="128" y="239" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="44" font-weight="800" letter-spacing="6" fill="${palette.ink}">DEV</text>`,
].join("\n")

const viewBox = [leftEdge, markTop, 2 * (center - leftEdge), 2 * (center - markTop)].join(" ")
writeFileSync("assets/icon.svg", tile())
writeFileSync("site/public/favicon.svg", tile())
writeFileSync("assets/icon-dev.svg", tile("translate(36 20) scale(0.71875)", devBand))
writeFileSync(
  "assets/logo.svg",
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" fill="currentColor">${mark()}</svg>\n`,
)
// macOS draws app icons as an 824 px tile inside a transparent 1024 px canvas.
for (const name of ["icon", "icon-dev"]) {
  const png = execFileSync("rsvg-convert", ["-w", "824", "-h", "824", `assets/${name}.svg`])
  execFileSync(
    "magick",
    ["png:-", "-background", "none", "-gravity", "center", "-extent", "1024x1024", "-strip", `assets/${name}.png`],
    {
      input: png,
    },
  )
}
