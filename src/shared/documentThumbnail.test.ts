import { describe, expect, test } from "vitest"
import { CALLOUT_TONES } from "./documentCallout.ts"
import { documentOutline, type OutlineBlock } from "./documentOutline.ts"
import { linePath, THUMBNAIL_HEIGHT, THUMBNAIL_WIDTH, type ThumbnailMark, thumbnailMarks } from "./documentThumbnail.ts"

const everyBlock: ReadonlyArray<OutlineBlock> = [
  { kind: "heading", level: 1, text: "A title long enough to reach the widest bar it can draw" },
  { kind: "text", length: 900 },
  { kind: "heading", level: 2, text: "見出し" },
  { kind: "list", items: 9 },
  { kind: "heading", level: 3, text: "Deep" },
  { kind: "tasks", done: 2, total: 9 },
  { kind: "table", rows: 9, columns: 9 },
  { kind: "code" },
  { kind: "chart" },
  { kind: "diagram" },
  ...CALLOUT_TONES.map((tone): OutlineBlock => ({ kind: "callout", tone })),
]

const bounds = (mark: ThumbnailMark) => {
  switch (mark.kind) {
    case "rect":
    case "outline":
      return { left: mark.x, top: mark.y, right: mark.x + mark.width, bottom: mark.y + mark.height }
    case "dot":
      return { left: mark.cx - mark.r, top: mark.cy - mark.r, right: mark.cx + mark.r, bottom: mark.cy + mark.r }
    case "line":
      return {
        left: Math.min(...mark.segments.map(({ x1 }) => x1)),
        top: Math.min(...mark.segments.map(({ y }) => y)),
        right: Math.max(...mark.segments.map(({ x2 }) => x2)),
        bottom: Math.max(...mark.segments.map(({ y }) => y)),
      }
  }
}

const expectInsidePage = (marks: ReadonlyArray<ThumbnailMark>) => {
  for (const mark of marks) {
    const { left, top, right, bottom } = bounds(mark)
    expect(left).toBeGreaterThanOrEqual(0)
    expect(top).toBeGreaterThanOrEqual(0)
    expect(right).toBeLessThanOrEqual(THUMBNAIL_WIDTH)
    expect(bottom).toBeLessThanOrEqual(THUMBNAIL_HEIGHT)
  }
}

const inks = (block: OutlineBlock) => new Set(thumbnailMarks([block]).map((mark) => mark.ink))

describe("thumbnailMarks", () => {
  test("keeps every block's marks inside the page", () => {
    for (const block of everyBlock) expectInsidePage(thumbnailMarks([block]))
    expectInsidePage(thumbnailMarks(everyBlock))
    expectInsidePage(thumbnailMarks(null))
  })

  test("stops drawing at the bottom of the page", () => {
    const long = Array.from({ length: 40 }, (): OutlineBlock => ({ kind: "callout", tone: "note" }))
    const marks = thumbnailMarks(long)
    expect(marks.length).toBeGreaterThan(0)
    expect(marks.length).toBeLessThan(long.length * 3)
    expect(Math.max(...marks.map((mark) => bounds(mark).bottom))).toBeLessThanOrEqual(THUMBNAIL_HEIGHT - 7)
  })

  test("draws nothing for an empty outline, and a wireframe when there is no outline", () => {
    expect(thumbnailMarks([])).toEqual([])
    expect(thumbnailMarks(null).length).toBeGreaterThan(0)
  })

  test("draws the same marks for the same blocks", () => {
    const { blocks } = documentOutline("# Plan\n\nBody.\n\n- a\n- b\n\n```ts\nx\n```\n\n> [!TIP]\n> Yes.")
    expect(thumbnailMarks(blocks)).toEqual(thumbnailMarks(structuredClone(blocks)))
  })

  test("paints a callout in its tone and a chart in the chart ink", () => {
    for (const tone of CALLOUT_TONES) expect(inks({ kind: "callout", tone })).toEqual(new Set([tone]))
    expect(inks({ kind: "chart" })).toEqual(new Set(["chart", "ink"]))
  })

  test("joins a diagram's arrows into one path, moved onto the page", () => {
    const line = thumbnailMarks([{ kind: "diagram" }]).find((mark) => mark.kind === "line")
    expect(line && linePath(line)).toBe("M16 10.5H23.5M32.5 10.5H40")
  })

  test("fills a finished task and outlines an open one", () => {
    const kinds = thumbnailMarks([{ kind: "tasks", done: 1, total: 2 }]).map((mark) => mark.kind)
    expect(kinds).toEqual(["rect", "rect", "outline", "rect"])
  })
})
