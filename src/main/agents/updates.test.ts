import { expect, test } from "@effect/vitest"
import { isNewer, parseVersion } from "./updates.ts"

test("reads the version out of what each CLI prints for --version", () => {
  expect(parseVersion("2.1.303 (Claude Code)\n")).toBe("2.1.303")
  expect(parseVersion("codex-cli 0.162.1\n")).toBe("0.162.1")
  expect(parseVersion("command not found")).toBeUndefined()
})

test("compares versions part by part, as numbers", () => {
  expect(isNewer("0.163.0", "0.162.1")).toBe(true)
  expect(isNewer("2.1.10", "2.1.9")).toBe(true)
  expect(isNewer("2.1.303", "2.1.303")).toBe(false)
  expect(isNewer("0.162.1", "0.163.0")).toBe(false)
})
