import { describe, expect, it } from "vitest"
import { drawWhiteboard, whiteboardHtml } from "./whiteboard-drawing"

const box = (id: string, x: number, label?: string) => ({
  id,
  type: "rectangle",
  x,
  y: 0,
  width: 100,
  height: 80,
  ...(label === undefined ? {} : { label: { text: label } }),
})

describe("drawWhiteboard", () => {
  it("draws nothing for a whiteboard without live elements", () => {
    expect(drawWhiteboard({ elements: [] })).toBeNull()
    expect(drawWhiteboard({ elements: [{ ...box("a", 0), isDeleted: true }] })).toBeNull()
  })

  it("centers a skeleton label inside its shape", () => {
    const drawing = drawWhiteboard({ elements: [box("api", 0, "API")] })
    expect(drawing?.marks).toContainEqual(expect.objectContaining({ kind: "shape", shape: "rectangle" }))
    expect(drawing?.marks).toContainEqual(
      expect.objectContaining({
        kind: "text",
        text: "API",
        align: "center",
        box: { x: 0, y: 0, width: 100, height: 80 },
      }),
    )
  })

  it("attaches a skeleton arrow to the facing edges of the shapes it names", () => {
    const drawing = drawWhiteboard({
      elements: [
        box("api", 0),
        box("db", 300),
        { id: "api-db", type: "arrow", x: 100, y: 40, start: { id: "api" }, end: { id: "db" } },
      ],
    })
    const arrow = drawing?.marks.find((mark) => mark.kind === "path")
    expect(arrow).toMatchObject({
      points: [
        [100, 40],
        [300, 40],
      ],
      arrowheads: { start: false, end: true },
    })
  })

  it("draws a full element's bound text once, where Excalidraw placed it", () => {
    const drawing = drawWhiteboard({
      elements: [
        { ...box("api", 0), version: 3, boundElements: [{ id: "api-text", type: "text" }] },
        {
          id: "api-text",
          type: "text",
          version: 3,
          x: 30,
          y: 28,
          width: 40,
          height: 25,
          text: "API",
          containerId: "api",
        },
      ],
    })
    const texts = drawing?.marks.filter((mark) => mark.kind === "text")
    expect(texts).toEqual([expect.objectContaining({ text: "API", box: { x: 30, y: 28, width: 40, height: 25 } })])
  })

  it("frames the children a skeleton frame names when it has no size", () => {
    const drawing = drawWhiteboard({
      elements: [
        box("api", 0),
        box("db", 300),
        { id: "backend", type: "frame", name: "Backend", children: ["api", "db"] },
      ],
    })
    const frame = drawing?.marks.find((mark) => mark.kind === "frame")
    expect(frame).toMatchObject({ name: "Backend" })
    expect(frame?.kind === "frame" && frame.box.x < 0 && frame.box.x + frame.box.width > 400).toBe(true)
  })
})

describe("whiteboardHtml", () => {
  it("escapes the text and colors an agent wrote", () => {
    const drawing = drawWhiteboard({
      elements: [{ ...box("x", 0, "<script>alert(1)</script>"), strokeColor: '"/><script>' }],
    })
    const html = whiteboardHtml(drawing!, "light")
    expect(html).not.toContain("<script>")
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;")
  })
})
