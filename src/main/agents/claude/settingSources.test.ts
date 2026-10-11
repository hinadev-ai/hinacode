import { expect, test } from "@effect/vitest"
import { settingSources } from "./settingSources.ts"

test("an untrusted project loads only the user's own Claude settings", () => {
  expect(settingSources(false)).toStrictEqual(["user"])
})

test("a trusted project also loads its .claude settings and CLAUDE.md", () => {
  expect(settingSources(true)).toStrictEqual(["user", "project", "local"])
})
