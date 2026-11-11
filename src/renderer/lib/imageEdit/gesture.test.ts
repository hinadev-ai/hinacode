import { describe, expect, it } from "vitest"
import { imageBounds } from "./document.ts"
import { type DragOptions, dragTo, finish, fitView, type Gesture, startDrawing, toImage, toScreen } from "./gesture.ts"

const image = imageBounds(400, 300)
const options: DragOptions = { shift: false, image, penStep: 1 }

describe("gestures", () => {
  it("adds a rectangle drawn from any corner", () => {
    const gesture = dragTo(startDrawing("rect", "r", "#ff375f", { x: 50, y: 60 }), { x: 10, y: 20 }, options)
    expect(finish(gesture, image, 4)).toEqual({
      type: "add",
      shape: { id: "r", kind: "rect", rect: { x: 10, y: 20, width: 40, height: 40 }, color: "#ff375f" },
    })
  })

  it("treats a click with a shape tool as nothing", () => {
    const gesture = dragTo(startDrawing("arrow", "a", "#ff375f", { x: 50, y: 50 }), { x: 51, y: 52 }, options)
    expect(finish(gesture, image, 4)).toBeNull()
  })

  it("keeps a crop inside the image and clears it when it covers the whole image again", () => {
    const view = fitView(image, { width: 800, height: 600 }, 0)
    const crop: Gesture = { kind: "crop", handle: "nw", original: image, rect: image, view }
    const dragged = dragTo(crop, { x: -80, y: 100 }, options)
    expect(finish(dragged, image, 4)).toEqual({ type: "crop", rect: { x: 0, y: 100, width: 400, height: 200 } })
    const restored: Gesture = {
      kind: "crop",
      handle: "n",
      original: { ...image, y: 100, height: 200 },
      rect: image,
      view,
    }
    expect(finish(dragTo(restored, { x: 0, y: -50 }, options), image, 4)).toEqual({ type: "crop", rect: null })
  })

  it("does not record a move that went nowhere", () => {
    const shape = { id: "m", kind: "marker", at: { x: 5, y: 5 }, color: "#ff375f" } as const
    const away = dragTo({ kind: "move", start: { x: 5, y: 5 }, original: shape, shape }, { x: 40, y: 9 }, options)
    expect(finish(dragTo(away, { x: 5, y: 5 }, options), image, 4)).toBeNull()
  })

  it("fits the image in the stage and maps screen points back to image pixels", () => {
    const view = fitView(image, { width: 220, height: 320 }, 10)
    expect(view.scale).toBeCloseTo(0.5)
    const corner = toScreen(view, { x: 400, y: 300 })
    expect(toImage(view, corner.x, corner.y)).toEqual({ x: 400, y: 300 })
  })
})
