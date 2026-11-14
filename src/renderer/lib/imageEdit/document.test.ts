import { describe, expect, it } from "vitest"
import { type Command, type EditLog, emptyLog, markerNumber, push, redo, replay, type Shape, undo } from "./document.ts"

const marker = (id: string): Shape => ({ id, kind: "marker", at: { x: 0, y: 0 }, color: "#ff375f" })
const box = (id: string, x = 0): Shape => ({
  id,
  kind: "rect",
  rect: { x, y: 0, width: 10, height: 10 },
  color: "#ff375f",
})
const run = (...commands: ReadonlyArray<Command>): EditLog => commands.reduce(push, emptyLog)

describe("edit log", () => {
  it("replays adds, updates, removes and crops in order", () => {
    const log = run(
      { type: "add", shape: box("a") },
      { type: "add", shape: box("b") },
      { type: "update", shape: box("a", 50) },
      { type: "remove", id: "b" },
      { type: "crop", rect: { x: 1, y: 2, width: 3, height: 4 } },
    )
    expect(replay(log)).toEqual({ shapes: [box("a", 50)], crop: { x: 1, y: 2, width: 3, height: 4 } })
  })

  it("undoes back to the untouched image and redoes forward again", () => {
    const log = run({ type: "add", shape: box("a") }, { type: "crop", rect: { x: 0, y: 0, width: 5, height: 5 } })
    expect(replay(undo(undo(log)))).toEqual({ shapes: [], crop: null })
    expect(replay(redo(undo(log)))).toEqual(replay(log))
    expect(undo(emptyLog)).toBe(emptyLog)
  })

  it("drops the redo branch when a new command follows an undo", () => {
    const log = push(undo(run({ type: "add", shape: box("a") }, { type: "add", shape: box("b") })), {
      type: "add",
      shape: box("c"),
    })
    expect(replay(log).shapes.map((shape) => shape.id)).toEqual(["a", "c"])
    expect(redo(log)).toBe(log)
  })

  it("numbers markers by their order, so removing one closes the gap", () => {
    const log = run(
      { type: "add", shape: marker("one") },
      { type: "add", shape: box("box") },
      { type: "add", shape: marker("two") },
      { type: "add", shape: marker("three") },
    )
    const { shapes } = replay(push(log, { type: "remove", id: "two" }))
    expect(markerNumber(shapes, "one")).toBe(1)
    expect(markerNumber(shapes, "three")).toBe(2)
  })
})
