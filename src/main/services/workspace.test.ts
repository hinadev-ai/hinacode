import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import * as Db from "../db/client.ts"
import { type SeedThread, seedThread } from "../db/testing.ts"
import { makeActiveWorkspace } from "./workspace.ts"

const resolve = (
  seed: SeedThread,
  mutate: (sql: SqlClient.SqlClient, ids: { threadId: string }) => Effect.Effect<unknown, unknown> = () => Effect.void,
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const ids = yield* seedThread(seed)
      yield* mutate(sql, ids)
      const activeWorkspace = yield* makeActiveWorkspace
      return yield* activeWorkspace(ids.threadId).pipe(Effect.result)
    }).pipe(Effect.provide(Db.layer(":memory:"))),
  )

describe("activeWorkspace", () => {
  test("is the project root with no base for a thread without a worktree", async () => {
    const result = await resolve({ rootPath: "/repo" })
    assert.deepEqual(result._tag === "Success" && result.success, { cwd: "/repo", baseRef: null })
  })

  test("is the worktree and its base while the worktree is active", async () => {
    const result = await resolve({ rootPath: "/repo", worktree: { path: "/wt", baseRef: "main", status: "ready" } })
    assert.deepEqual(result._tag === "Success" && result.success, { cwd: "/wt", baseRef: "main" })
  })

  test("falls back to the project root with no base once the worktree is removed", async () => {
    const result = await resolve({ rootPath: "/repo", worktree: { path: "/wt", baseRef: "main", status: "removed" } })
    assert.deepEqual(result._tag === "Success" && result.success, { cwd: "/repo", baseRef: null })
  })

  test("falls back to the project root when the worktree row is gone", async () => {
    const result = await resolve(
      { rootPath: "/repo", worktree: { path: "/wt", baseRef: "main", status: "ready" } },
      (sql) => sql`DELETE FROM worktree`,
    )
    assert.deepEqual(result._tag === "Success" && result.success, { cwd: "/repo", baseRef: null })
  })

  test("fails with NotFoundError for a deleted thread", async () => {
    const result = await resolve(
      { rootPath: "/repo" },
      (sql, { threadId }) => sql`DELETE FROM thread WHERE id = ${threadId}`,
    )
    assert.equal(result._tag === "Failure" && result.failure._tag, "NotFoundError")
  })
})
