import { afterEach, expect, test, vi } from "vitest"
import { createDocumentEngine } from "./engine.ts"

afterEach(() => vi.unstubAllGlobals())

test("the engine starts under React Native's navigator, which has no userAgent", () => {
  vi.stubGlobal("navigator", { product: "ReactNative" })
  const engine = createDocumentEngine()
  engine.load(engine.editor.state.doc)
  expect(engine.press("Enter")).toBe(true)
  engine.editor.destroy()
})
