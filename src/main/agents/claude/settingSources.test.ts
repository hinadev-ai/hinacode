import assert from "node:assert/strict"
import { test } from "node:test"
import { settingSources } from "./settingSources.ts"

test("an untrusted project loads only the user's own Claude settings", () => {
  assert.deepEqual(settingSources(false), ["user"])
})

test("a trusted project also loads its .claude settings and CLAUDE.md", () => {
  assert.deepEqual(settingSources(true), ["user", "project", "local"])
})
