import { expect, test } from "vitest"
import { drawDiagram, svgToDrawing } from "./diagram.ts"
import { DIAGRAM_PATH } from "./protocol.ts"

const DIAGRAMS = {
  flowchart: [
    "graph LR\n  A((Start)) --> B{Ready?}\n  B -->|yes| C[Ship it]\n  B -.->|no| D([Fix])",
    ["Start", "Ready?", "Ship it", "Fix", "yes", "no"],
  ],
  sequence: ["sequenceDiagram\n  Alice->>Bob: Hello\n  Bob-->>Alice: Hi back", ["Alice", "Bob", "Hello", "Hi back"]],
  state: ["stateDiagram-v2\n  [*] --> Still\n  Still --> Moving", ["Still", "Moving"]],
  pie: ['pie title Pets\n  "Dogs" : 3\n  "Cats" : 2', ["Pets", "Dogs", "Cats"]],
  gantt: ["gantt\n  title Plan\n  dateFormat YYYY-MM-DD\n  section A\n  Build :a1, 2026-01-01, 3d", ["Plan", "Build"]],
} as const

const operandCount: Readonly<Record<number, number>> = {
  [DIAGRAM_PATH.move]: 2,
  [DIAGRAM_PATH.line]: 2,
  [DIAGRAM_PATH.cubic]: 6,
  [DIAGRAM_PATH.close]: 0,
}

const onCurvePoints = (data: ReadonlyArray<number>) => {
  const out: [number, number][] = []
  for (let index = 0; index < data.length;) {
    const count = operandCount[data[index]!]
    expect(count, `unknown path op ${data[index]}`).toBeDefined()
    if (count! > 0) out.push([data[index + count! - 1]!, data[index + count!]!])
    index += 1 + count!
  }
  return out
}

test.each(Object.entries(DIAGRAMS))(
  "a %s diagram becomes paths and every label, inside its box",
  async (_, [source, labels]) => {
    const drawing = await drawDiagram(source)
    expect(drawing).not.toBeNull()
    const { width, height, shapes } = drawing!
    const texts = shapes.flatMap((shape) => (shape.kind === "text" ? [shape.text] : []))
    for (const label of labels) expect(texts.join(" ")).toContain(label)
    const paths = shapes.filter((shape) => shape.kind === "path")
    expect(paths.length).toBeGreaterThan(0)
    const margin = 2
    for (const shape of paths)
      for (const [x, y] of onCurvePoints(shape.data)) {
        expect(Number.isFinite(x) && Number.isFinite(y)).toBe(true)
        expect(x).toBeGreaterThanOrEqual(-margin)
        expect(y).toBeGreaterThanOrEqual(-margin)
        expect(x).toBeLessThanOrEqual(width + margin)
        expect(y).toBeLessThanOrEqual(height + margin)
      }
  },
)

test("transforms, arcs, theme variables and entities resolve to absolute geometry and roles", () => {
  const drawing = svgToDrawing(
    `<svg viewBox="10 20 100 100" fill="var(--_fg)"><g transform="translate(20,30)" stroke="var(--_l)"><path d="M0,0 a10,10 0 0 1 20,0" fill="none"/><rect x="0" y="0" width="10" height="5" fill="var(--_s)"/></g><text x="5" y="40" text-anchor="middle" font-weight="bold">A &amp; B<tspan x="5" y="55">two</tspan></text></svg>`,
  )!
  expect(drawing).toMatchObject({ width: 100, height: 100 })
  const [arc, rect, first, second] = drawing.shapes
  expect(arc).toMatchObject({ kind: "path", fill: null, stroke: "@line" })
  const arcPoints = onCurvePoints((arc as { data: number[] }).data)
  expect(arcPoints[0]).toEqual([10, 10])
  expect(arcPoints.at(-1)![0]).toBeCloseTo(30)
  expect(arcPoints.at(-1)![1]).toBeCloseTo(10)
  expect(Math.min(...arcPoints.map(([, y]) => y))).toBeCloseTo(0, 0)
  expect(rect).toMatchObject({ kind: "path", fill: "@surface", stroke: "@line" })
  expect(first).toMatchObject({ kind: "text", text: "A & B", x: -5, y: 20, anchor: "middle", weight: 700, fill: "@fg" })
  expect(second).toMatchObject({ kind: "text", text: "two", y: 35, anchor: "middle", weight: 700 })
})
