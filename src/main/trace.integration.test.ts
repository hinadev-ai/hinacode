import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { SqlClient } from "effect/sql"
import * as Db from "./db/client.ts"
import { traceLayer } from "./trace.ts"

const dir = mkdtempSync(join(tmpdir(), "kk-trace-test-"))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe("traceLayer", () => {
  it.live("writes each finished span with its parent and query text", () => {
    const file = join(dir, "trace.jsonl")
    const traced = Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* sql`SELECT 1 AS one`.pipe(Effect.withSpan("rpc threads.list"))
    }).pipe(Effect.provide(Db.layer(":memory:").pipe(Layer.provideMerge(traceLayer(file)))))
    return Effect.gen(function* () {
      yield* traced
      yield* Effect.sleep("50 millis")
      const spans = readFileSync(file, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
      const rpc = spans.find((span) => span.name === "rpc threads.list")
      const query = spans.find((span) => span.query === "SELECT 1 AS one")
      expect(query.parent).toBe(rpc.id)
      expect(rpc.ms).toBeGreaterThanOrEqual(query.ms)
    })
  })

  it("is a no-op without a file", () => {
    expect(traceLayer(undefined)).toBe(Layer.empty)
  })
})
