import { expect, test } from "vitest"
import { mergeScene } from "./whiteboard.ts"

const loadedScene = {
  elements: [
    { id: "api", type: "rectangle", boundElements: [{ id: "api-label", type: "text" }] },
    { id: "api-label", type: "text", text: "API", containerId: "api" },
    { id: "db", type: "rectangle" },
  ],
}

test("replacing a shape drops the label the editor bound to it", () => {
  const merged = mergeScene(loadedScene, { upsert: [{ id: "api", type: "rectangle", label: { text: "Gateway" } }] })
  expect(merged.elements.map((element) => element.id)).toEqual(["api", "db"])
})

test("removing a shape removes its bound label", () => {
  const merged = mergeScene(loadedScene, { upsert: [], remove: ["api"] })
  expect(merged.elements.map((element) => element.id)).toEqual(["db"])
})

test("a label sent in the same patch stays", () => {
  const label = { id: "api-label", type: "text", text: "Edge", containerId: "api" }
  const merged = mergeScene(loadedScene, { upsert: [{ id: "api", type: "rectangle" }, label] })
  expect(merged.elements).toEqual([{ id: "api", type: "rectangle" }, label, { id: "db", type: "rectangle" }])
})
