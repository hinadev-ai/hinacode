import type { CalloutTone } from "./documentCallout.ts"
import type { OutlineBlock } from "./documentOutline.ts"

export type ThumbnailInk = "ink" | "chart" | CalloutTone

type Paint = { readonly ink: ThumbnailInk; readonly opacity: number }

type Box = {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  readonly radius: number
}

type Segment = { readonly x1: number; readonly x2: number; readonly y: number }

export type ThumbnailMark =
  | (Paint & Box & { readonly kind: "rect" })
  | (Paint & Box & { readonly kind: "outline"; readonly strokeWidth: number })
  | (Paint & { readonly kind: "dot"; readonly cx: number; readonly cy: number; readonly r: number })
  | (Paint & { readonly kind: "line"; readonly segments: ReadonlyArray<Segment>; readonly strokeWidth: number })

export const THUMBNAIL_WIDTH = 56
export const THUMBNAIL_HEIGHT = 74

const MARGIN = 7
const TOP = 8
const BOTTOM = THUMBNAIL_HEIGHT - 7
const LINE = THUMBNAIL_WIDTH - 2 * MARGIN
const GAP = 3
const BAR_HEIGHT = 1.2
const CHART_BARS = [0.45, 0.65, 0.5, 0.85, 1, 0.7]

type Shape = { readonly space: number; readonly height: number; readonly marks: ReadonlyArray<ThumbnailMark> }

const textWeight = (text: string) => [...text].reduce((sum, character) => sum + (character > "⹿" ? 2 : 1), 0)

const between = (min: number, max: number, fraction: number) => min + (max - min) * Math.min(1, Math.max(0, fraction))

const scatter = (seed: number, min: number, max: number) => between(min, max, (seed * 0.618034) % 1)

const lastLineWidth = (lines: number, seed: number) =>
  lines === 1 ? LINE * scatter(seed, 0.4, 0.95) : LINE * scatter(seed, 0.35, 0.8)

const bar = ({
  x = 0,
  y,
  width,
  height = BAR_HEIGHT,
  opacity,
  ink = "ink",
}: {
  readonly x?: number
  readonly y: number
  readonly width: number
  readonly height?: number
  readonly opacity: number
  readonly ink?: ThumbnailInk
}): ThumbnailMark => ({ kind: "rect", x, y, width, height, radius: height / 2, ink, opacity })

const panel = (y: number, height: number, radius: number, opacity: number, x = 0, width = LINE): ThumbnailMark => ({
  kind: "rect",
  x,
  y,
  width,
  height,
  radius,
  ink: "ink",
  opacity,
})

const rule = (x: number, y: number, width: number, height: number, opacity: number) =>
  panel(y, height, 0, opacity, x, width)

const moved = (mark: ThumbnailMark, dx: number, dy: number): ThumbnailMark => {
  switch (mark.kind) {
    case "rect":
    case "outline":
      return { ...mark, x: mark.x + dx, y: mark.y + dy }
    case "dot":
      return { ...mark, cx: mark.cx + dx, cy: mark.cy + dy }
    case "line":
      return {
        ...mark,
        segments: mark.segments.map(({ x1, x2, y }) => ({ x1: x1 + dx, x2: x2 + dx, y: y + dy })),
      }
  }
}

const rows = (count: number, draw: (row: number) => ReadonlyArray<ThumbnailMark>) =>
  Array.from({ length: count }, (_, row) => draw(row)).flat()

const headingShape = (block: Extract<OutlineBlock, { kind: "heading" }>): Shape => {
  const weight = textWeight(block.text)
  if (block.level === 1)
    return {
      space: 0,
      height: 3,
      marks: [bar({ y: 0, width: LINE * between(0.4, 0.9, weight / 40), height: 3, opacity: 0.7 })],
    }
  const height = block.level === 2 ? 2.2 : 1.8
  const width = LINE * between(0.3, block.level === 2 ? 0.7 : 0.55, weight / 50)
  return { space: 2, height, marks: [bar({ y: 0, width, height, opacity: block.level === 2 ? 0.5 : 0.4 })] }
}

const textShape = (block: Extract<OutlineBlock, { kind: "text" }>): Shape => {
  const lines = Math.min(3, Math.max(1, Math.ceil(block.length / 80)))
  return {
    space: 0,
    height: (lines - 1) * 3 + BAR_HEIGHT,
    marks: rows(lines, (line) => [
      bar({ y: line * 3, width: line === lines - 1 ? lastLineWidth(lines, block.length) : LINE, opacity: 0.2 }),
    ]),
  }
}

const listShape = (block: Extract<OutlineBlock, { kind: "list" }>, index: number): Shape => {
  const count = Math.min(4, Math.max(1, block.items))
  return {
    space: 0,
    height: (count - 1) * 3.4 + 1.6,
    marks: rows(count, (row) => [
      { kind: "dot", cx: 0.8, cy: row * 3.4 + 0.8, r: 0.8, ink: "ink", opacity: 0.35 },
      bar({
        x: 3,
        y: row * 3.4 + 0.2,
        width: (LINE - 3) * scatter(index + row + block.items, 0.45, 0.9),
        opacity: 0.2,
      }),
    ]),
  }
}

const tasksShape = (block: Extract<OutlineBlock, { kind: "tasks" }>, index: number): Shape => {
  const count = Math.min(4, Math.max(1, block.total))
  return {
    space: 0,
    height: (count - 1) * 3.8 + 2.2,
    marks: rows(count, (row) => {
      const top = row * 3.8
      const box: ThumbnailMark =
        row < block.done
          ? panel(top, 2.2, 0.6, 0.45, 0, 2.2)
          : {
              kind: "outline",
              x: 0.25,
              y: top + 0.25,
              width: 1.7,
              height: 1.7,
              radius: 0.5,
              ink: "ink",
              opacity: 0.4,
              strokeWidth: 0.5,
            }
      const width = (LINE - 4) * scatter(index + row + block.total, 0.4, 0.85)
      return [box, bar({ x: 4, y: top + 0.5, width, opacity: 0.2 })]
    }),
  }
}

const tableShape = (block: Extract<OutlineBlock, { kind: "table" }>): Shape => {
  const columns = Math.min(4, Math.max(1, block.columns))
  const lines = Math.min(4, Math.max(1, block.rows)) + 1
  const row = 3
  return {
    space: 0,
    height: lines * row,
    marks: [
      panel(0, row, 1, 0.1),
      ...rows(lines, (line) => [rule(0, (line + 1) * row - 0.4, LINE, 0.4, 0.14)]),
      ...rows(columns - 1, (line) => [rule(((line + 1) * LINE) / columns, 0, 0.4, lines * row, 0.14)]),
    ],
  }
}

const codeShape = (index: number): Shape => ({
  space: 0,
  height: 8,
  marks: [
    panel(0, 8, 1.5, 0.07),
    bar({ x: 2.5, y: 2.2, width: LINE * scatter(index, 0.3, 0.55), height: 1, opacity: 0.25 }),
    bar({ x: 2.5, y: 4.8, width: LINE * scatter(index + 1, 0.45, 0.75), height: 1, opacity: 0.25 }),
  ],
})

const chartShape = (): Shape => ({
  space: 0,
  height: 10,
  marks: [
    ...CHART_BARS.map((share, index): ThumbnailMark => ({
      kind: "rect",
      x: 1 + index * 5,
      y: 9.4 - share * 9,
      width: 3.4,
      height: share * 9,
      radius: 0.6,
      ink: "chart",
      opacity: 0.75,
    })),
    rule(0, 9.6, LINE, 0.4, 0.2),
  ],
})

const diagramShape = (): Shape => {
  const box = 9
  const middle = (LINE - box) / 2
  const stroke = { ink: "ink", opacity: 0.4, strokeWidth: 0.6 } as const
  return {
    space: 0,
    height: 5,
    marks: [
      ...[0, middle, LINE - box].map((x): ThumbnailMark => ({
        kind: "outline",
        x: x + 0.3,
        y: 0.3,
        width: box - 0.6,
        height: 4.4,
        radius: 1,
        ...stroke,
      })),
      {
        kind: "line",
        segments: [
          { x1: box, x2: middle, y: 2.5 },
          { x1: middle + box, x2: LINE - box, y: 2.5 },
        ],
        ...stroke,
      },
    ],
  }
}

const calloutShape = (tone: CalloutTone): Shape => ({
  space: 0,
  height: 7.5,
  marks: [
    { kind: "rect", x: 0, y: 0, width: LINE, height: 7.5, radius: 1.5, ink: tone, opacity: 0.14 },
    bar({ x: 2.5, y: 2, width: LINE - 5, height: 1.1, opacity: 0.55, ink: tone }),
    bar({ x: 2.5, y: 4.4, width: (LINE - 5) * 0.55, height: 1.1, opacity: 0.55, ink: tone }),
  ],
})

const blockShape = (block: OutlineBlock, index: number): Shape => {
  switch (block.kind) {
    case "heading":
      return headingShape(block)
    case "text":
      return textShape(block)
    case "list":
      return listShape(block, index)
    case "tasks":
      return tasksShape(block, index)
    case "table":
      return tableShape(block)
    case "code":
      return codeShape(index)
    case "chart":
      return chartShape()
    case "diagram":
      return diagramShape()
    case "callout":
      return calloutShape(block.tone)
  }
}

const outlineMarks = (blocks: ReadonlyArray<OutlineBlock>) => {
  const marks: Array<ThumbnailMark> = []
  let y = TOP
  for (const [index, block] of blocks.entries()) {
    const shape = blockShape(block, index)
    const top = index === 0 ? y : y + shape.space
    if (top + shape.height > BOTTOM) break
    marks.push(...shape.marks.map((mark) => moved(mark, MARGIN, top)))
    y = top + shape.height + GAP
  }
  return marks
}

const PAGE_WIREFRAME: ReadonlyArray<ThumbnailMark> = [
  bar({ y: 0, width: 8, height: 1.6, opacity: 0.45 }),
  ...rows(3, (link) => [bar({ x: LINE - 15 + link * 5.5, y: 0.2, width: 3.5, opacity: 0.2 })]),
  bar({ y: 7, width: LINE * 0.7, height: 3, opacity: 0.7 }),
  bar({ y: 13, width: LINE, opacity: 0.2 }),
  bar({ y: 16, width: LINE * 0.6, opacity: 0.2 }),
  panel(21, 14, 1.5, 0.07),
  ...rows(3, (card) => [panel(38, 10, 1, 0.07, card * ((LINE + 2) / 3), (LINE - 4) / 3)]),
  bar({ y: 52, width: LINE, opacity: 0.2 }),
  bar({ y: 55, width: LINE * 0.45, opacity: 0.2 }),
].map((mark) => moved(mark, MARGIN, TOP))

export const linePath = ({ segments }: Extract<ThumbnailMark, { kind: "line" }>) =>
  segments.map(({ x1, x2, y }) => `M${x1} ${y}H${x2}`).join("")

export const thumbnailMarks = (blocks: ReadonlyArray<OutlineBlock> | null): ReadonlyArray<ThumbnailMark> =>
  blocks === null ? PAGE_WIREFRAME : outlineMarks(blocks)
