import { describe, expect, it } from "vitest"
import type { Shape } from "./document.ts"
import { resizeRect, snapToEighth, squareCorner, topmostShapeAt, translate } from "./geometry.ts"

const noText = () => ({ x: 0, y: 0, width: 0, height: 0 })

describe("geometry", () => {
  it("keeps a rectangle normalized when a handle is dragged past the opposite edge", () => {
    expect(resizeRect({ x: 10, y: 10, width: 20, height: 20 }, "nw", { x: 40, y: 50 })).toEqual({
      x: 30,
      y: 30,
      width: 10,
      height: 20,
    })
    expect(resizeRect({ x: 10, y: 10, width: 20, height: 20 }, "e", { x: 15, y: 999 })).toEqual({
      x: 10,
      y: 10,
      width: 5,
      height: 20,
    })
  })

  it("constrains Shift drags to squares and 45 degree lines", () => {
    expect(squareCorner({ x: 0, y: 0 }, { x: -30, y: 10 })).toEqual({ x: -30, y: 30 })
    const snapped = snapToEighth({ x: 0, y: 0 }, { x: 100, y: 10 })
    expect(snapped.x).toBeCloseTo(Math.hypot(100, 10))
    expect(snapped.y).toBeCloseTo(0)
  })

  it("hits a hollow rectangle on its outline, not inside it", () => {
    const outline: Shape = { id: "r", kind: "rect", rect: { x: 0, y: 0, width: 100, height: 100 }, color: "#ff375f" }
    expect(topmostShapeAt([outline], { x: 50, y: 2 }, 4, noText)?.id).toBe("r")
    expect(topmostShapeAt([outline], { x: 50, y: 50 }, 4, noText)).toBeUndefined()
  })

  it("picks the shape drawn last where two overlap", () => {
    const under: Shape = { id: "under", kind: "redact", rect: { x: 0, y: 0, width: 50, height: 50 } }
    const over: Shape = { id: "over", kind: "arrow", from: { x: 0, y: 25 }, to: { x: 50, y: 25 }, color: "#ff375f" }
    expect(topmostShapeAt([under, over], { x: 25, y: 26 }, 4, noText)?.id).toBe("over")
    expect(topmostShapeAt([under, over], { x: 25, y: 45 }, 4, noText)?.id).toBe("under")
  })

  it("moves every point of a pen stroke", () => {
    const pen: Shape = {
      id: "p",
      kind: "pen",
      points: [
        { x: 0, y: 0 },
        { x: 5, y: 5 },
      ],
      color: "#ff375f",
    }
    expect(translate(pen, 10, -1)).toMatchObject({
      points: [
        { x: 10, y: -1 },
        { x: 15, y: 4 },
      ],
    })
  })
})
