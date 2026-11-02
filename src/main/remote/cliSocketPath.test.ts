import { expect, test } from "vitest"
import { cliSocketPath } from "./cliSocketPath.ts"

test("the socket sits in the data folder's run folder when the path fits", () => {
  expect(cliSocketPath("/home/me/.hinacode", "/run/hc")).toBe("/home/me/.hinacode/run/cli.sock")
})

test("a deep data folder gets a stable socket in the private runtime folder", () => {
  const deep = `/home/me/${"x".repeat(120)}`
  const path = cliSocketPath(deep, "/run/hc")
  expect(path).toMatch(/^\/run\/hc\/[0-9a-f]{16}\.sock$/)
  expect(cliSocketPath(deep, "/run/hc")).toBe(path)
  expect(cliSocketPath(`${deep}2`, "/run/hc")).not.toBe(path)
})
