import { describe, expect, test } from "@effect/vitest"
import { vi } from "vitest"
import { selectSidePanelView, useUi } from "./ui.ts"

vi.hoisted(() => {
  const values = new Map<string, string>()
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  })
  vi.stubGlobal("window", { innerWidth: 1500 })
  vi.stubGlobal("document", { documentElement: {}, querySelector: () => null })
  vi.stubGlobal("getComputedStyle", () => ({ fontSize: "16px" }))
})

const viewOf = (threadId: string) => selectSidePanelView(threadId)(useUi.getState())

describe("side panel views", () => {
  test("a thread opened for the first time shows the view picked last", () => {
    useUi.getState().showView("a", "files")
    expect(viewOf("new")).toBe("files")
  })

  test("a new thread does not open on another thread's browser", () => {
    useUi.getState().showView("a", "changes")
    useUi.getState().showView("a", "browser")
    expect(viewOf("new")).toBe("changes")
    expect(viewOf("a")).toBe("browser")
  })
})
