import { describe, expect, test } from "@effect/vitest"
import { vi } from "vitest"
import { conflictsOf, resolveKeymap } from "./commands.ts"

// Commands import the ui store, which reads the saved sidebar width from localStorage when it is created,
// and the window's project, read from the page URL.
vi.hoisted(() => {
  vi.stubGlobal("location", new URL("file:///index.html"))
  const values = new Map<string, string>()
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  })
})

describe("resolveKeymap", () => {
  test("loads overrides saved in the lowercase form used before TanStack Hotkeys", () => {
    const keymap = resolveKeymap({ "sidebar.toggle": "mod+shift+k", "thread.next": "alt+shift+1" })
    expect(keymap["sidebar.toggle"]).toBe("Mod+Shift+K")
    expect(keymap["thread.next"]).toBe("Alt+Shift+1")
  })

  test("keeps recorded physical keys and unbinds what it cannot parse", () => {
    const keymap = resolveKeymap({ "sidebar.toggle": "Mod+Shift+[KeyK]", "thread.new": "", "project.add": "+++" })
    expect(keymap["sidebar.toggle"]).toBe("Mod+Shift+[KeyK]")
    expect(keymap["thread.new"]).toBe("")
    expect(keymap["project.add"]).toBe("")
  })
})

describe("conflictsOf", () => {
  test("a recorded physical key conflicts with a default on the same key", () => {
    const keymap = resolveKeymap({ "thread.new": "Mod+[KeyB]" })
    expect(conflictsOf(keymap, "thread.new").map((command) => command.id)).toStrictEqual(["sidebar.toggle"])
    expect(conflictsOf(keymap, "sidebar.toggle").map((command) => command.id)).toStrictEqual(["thread.new"])
  })

  test("unbound commands conflict with nothing", () => {
    const keymap = resolveKeymap({ "thread.new": "", "project.add": "" })
    expect(conflictsOf(keymap, "thread.new")).toStrictEqual([])
  })
})
