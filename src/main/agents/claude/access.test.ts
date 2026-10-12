import { expect, test } from "@effect/vitest"
import { permissionMode } from "./access.ts"

test("supervised asks through canUseTool and full skips every check", () => {
  expect(permissionMode("supervised", true)).toBe("default")
  expect(permissionMode("full", false)).toBe("bypassPermissions")
})

test("auto uses Claude's classifier, or only accepts edits on a model without it", () => {
  expect(permissionMode("auto", true)).toBe("auto")
  expect(permissionMode("auto", false)).toBe("acceptEdits")
})
