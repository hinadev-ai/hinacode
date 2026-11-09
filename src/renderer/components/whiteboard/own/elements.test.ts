import { describe, expect, test } from "vitest"
import type { WhiteboardElement } from "../../../../shared/artifact.ts"
import {
  arrowGeometry,
  boundsOf,
  bumpChanged,
  byIdOf,
  charactersPerLine,
  completeElement,
  contentBounds,
  elementsInBounds,
  fitView,
  flattenBounds,
  hitTest,
  moveElements,
  nextVersion,
  normalizeScene,
  resizeElements,
  toWorld,
  unionBounds,
  tombstone,
  wrapText,
  zoomAt,
  type OwnElement,
} from "./elements.ts"

const shape = (id: string, extra: Partial<OwnElement> = {}): OwnElement => ({
  id,
  type: "rectangle",
  version: 1,
  x: 0,
  y: 0,
  width: 100,
  height: 50,
  ...extra,
})

const raw = (id: string, extra: Record<string, unknown> = {}): WhiteboardElement => ({
  id,
  type: "rectangle",
  ...extra,
})

describe("completeElement", () => {
  test("fills bounds and the start and end bindings of a skeleton arrow", () => {
    const arrow = completeElement(raw("a-b", { type: "arrow", start: { id: "a" }, endBinding: { elementId: "b" } }))
    expect(arrow.start).toEqual({ id: "a" })
    expect(arrow.end).toEqual({ id: "b" })
    expect(arrow.version).toBe(0)
    expect(arrow.width).toBeGreaterThan(0)
  })

  test("reads a label object and free text", () => {
    expect(completeElement(raw("api", { label: { text: "API" } })).label).toEqual({ text: "API" })
    expect(completeElement(raw("t", { type: "text", text: "Hi" })).text).toBe("Hi")
  })
})

describe("normalizeScene", () => {
  test("folds an Excalidraw label child into its container", () => {
    const scene = normalizeScene([
      raw("api", { x: 0, y: 0, width: 100, height: 50 }),
      raw("api:label", { type: "text", containerId: "api", text: "API" }),
    ])
    expect(scene.map((element) => element.id)).toEqual(["api"])
    expect(scene[0]?.label).toEqual({ text: "API" })
  })
})

describe("arrowGeometry", () => {
  test("anchors both ends on the boundary of the bound shapes", () => {
    const elements = [
      shape("a", { x: 0, y: 0, width: 100, height: 100 }),
      shape("b", { x: 300, y: 0, width: 100, height: 100 }),
    ]
    const arrow = completeElement(raw("arrow", { type: "arrow", start: { id: "a" }, end: { id: "b" } }))
    const geometry = arrowGeometry(arrow, byIdOf(elements))
    expect(geometry.x1).toBe(100)
    expect(geometry.x2).toBe(300)
    expect(geometry.y1).toBe(geometry.y2)
  })
})

describe("hitTest", () => {
  const elements = [shape("box", { x: 0, y: 0, width: 100, height: 50 })]
  const byId = byIdOf(elements)
  test("hits inside a shape and misses outside", () => {
    expect(hitTest(elements, { x: 50, y: 25 }, byId)?.id).toBe("box")
    expect(hitTest(elements, { x: 400, y: 400 }, byId)).toBeUndefined()
  })
})

describe("selection", () => {
  const elements = [shape("a", { x: 0, y: 0 }), shape("b", { x: 400, y: 400 })]
  const byId = byIdOf(elements)
  test("a marquee takes only the shapes it intersects", () => {
    expect(elementsInBounds(elements, flattenBounds({ x: -10, y: -10 }, { x: 120, y: 80 }), byId)).toEqual(["a"])
  })
})

describe("transform", () => {
  test("moveElements shifts only the selected ids", () => {
    const moved = moveElements([shape("a"), shape("b")], new Set(["a"]), 10, -5)
    expect(moved[0]).toMatchObject({ x: 10, y: -5 })
    expect(moved[1]).toMatchObject({ x: 0, y: 0 })
  })

  test("resizeElements scales a selection from its bounds", () => {
    const resized = resizeElements([shape("a")], new Set(["a"]), boundsOf(shape("a")), {
      x: 0,
      y: 0,
      width: 200,
      height: 100,
    })
    expect(resized[0]).toMatchObject({ width: 200, height: 100 })
  })

  test("tombstone keeps a deleted element with a newer version", () => {
    const [a, b] = tombstone([shape("a"), shape("b")], new Set(["a"]))
    expect(a).toMatchObject({ id: "a", isDeleted: true, version: 2 })
    expect(b).toEqual(shape("b"))
  })

  test("bumpChanged versions only the elements whose object changed", () => {
    const unchanged = shape("a")
    const untouched = shape("b")
    const moved = moveElements([unchanged], new Set(["a"]), 10, 0)[0]!
    const [bumped, kept] = bumpChanged([unchanged, untouched], [moved, untouched])
    expect(bumped).toMatchObject({ x: 10, version: 2 })
    expect(kept).toBe(untouched)
  })
})

describe("view", () => {
  test("fitView keeps the content inside the viewport", () => {
    const view = fitView({ width: 800, height: 600 }, { x: 0, y: 0, width: 400, height: 300 })
    const topLeft = toWorld(view, { x: 0, y: 0 })
    const bottomRight = toWorld(view, { x: 800, y: 600 })
    expect(topLeft.x).toBeLessThanOrEqual(0)
    expect(topLeft.y).toBeLessThanOrEqual(0)
    expect(bottomRight.x).toBeGreaterThanOrEqual(400)
    expect(bottomRight.y).toBeGreaterThanOrEqual(300)
  })

  test("zoomAt keeps the pointer anchored", () => {
    const zoomed = zoomAt({ x: 0, y: 0, zoom: 1 }, { x: 200, y: 100 }, 2)
    expect(toWorld(zoomed, { x: 200, y: 100 })).toEqual({ x: 200, y: 100 })
  })
})

describe("text", () => {
  test("wraps a label to the width and keeps explicit line breaks", () => {
    expect(wrapText("one two three", 7)).toEqual(["one two", "three"])
    expect(wrapText("a\nb", 20)).toEqual(["a", "b"])
    expect(charactersPerLine(200, 16)).toBeGreaterThan(4)
  })
})

describe("versions", () => {
  test("nextVersion beats the highest element", () => {
    expect(nextVersion([shape("a", { version: 4 })])).toBe(5)
  })
})

describe("bounds", () => {
  test("unionBounds covers every box and contentBounds ignores arrows", () => {
    expect(
      unionBounds([
        { x: 0, y: 0, width: 10, height: 10 },
        { x: 5, y: 5, width: 10, height: 10 },
      ]),
    ).toEqual({
      x: 0,
      y: 0,
      width: 15,
      height: 15,
    })
    expect(contentBounds([shape("a"), { ...shape("arrow"), type: "arrow" }])).toEqual(boundsOf(shape("a")))
  })
})
