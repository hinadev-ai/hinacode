import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import * as Db from "../db/client.ts"
import { type SeedThread, seedThread } from "../db/testing.ts"
import { makeActiveWorkspace } from "./workspace.ts"

const resolve = (
  seed: SeedThread,
  mutate: (sql: SqlClient.SqlClient, ids: { threadId: string }) => Effect.Effect<unknown, unknown> = () => Effect.void,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const ids = yield* seedThread(seed)
    yield* mutate(sql, ids)
    const activeWorkspace = yield* makeActiveWorkspace
    return yield* activeWorkspace(ids.threadId).pipe(Effect.result)
  }).pipe(Effect.provide(Db.layer(":memory:")))

describe("activeWorkspace", () => {
  it.effect("is the project root with no base for a thread without a worktree", () =>
    Effect.gen(function* () {
      const result = yield* resolve({ rootPath: "/repo" })
      expect(result._tag === "Success" && result.success).toStrictEqual({
        cwd: "/repo",
        worktreeId: null,
        baseRef: null,
      })
    }),
  )

  it.effect("is the worktree and its base while the worktree is active", () =>
    Effect.gen(function* () {
      const result = yield* resolve({ rootPath: "/repo", worktree: { path: "/wt", baseRef: "main", status: "ready" } })
      expect(result._tag === "Success" && result.success).toStrictEqual({
        cwd: "/wt",
        worktreeId: expect.any(String),
        baseRef: "main",
      })
    }),
  )

  it.effect("falls back to the project root with no base once the worktree is removed", () =>
    Effect.gen(function* () {
      const result = yield* resolve({
        rootPath: "/repo",
        worktree: { path: "/wt", baseRef: "main", status: "removed" },
      })
      expect(result._tag === "Success" && result.success).toStrictEqual({
        cwd: "/repo",
        worktreeId: null,
        baseRef: null,
      })
    }),
  )

  it.effect("falls back to the project root when the worktree row is gone", () =>
    Effect.gen(function* () {
      const result = yield* resolve(
        { rootPath: "/repo", worktree: { path: "/wt", baseRef: "main", status: "ready" } },
        (sql) => sql`DELETE FROM worktree`,
      )
      expect(result._tag === "Success" && result.success).toStrictEqual({
        cwd: "/repo",
        worktreeId: null,
        baseRef: null,
      })
    }),
  )

  it.effect("fails with NotFoundError for a deleted thread", () =>
    Effect.gen(function* () {
      const result = yield* resolve(
        { rootPath: "/repo" },
        (sql, { threadId }) => sql`DELETE FROM thread WHERE id = ${threadId}`,
      )
      expect(result._tag === "Failure" && result.failure._tag).toBe("NotFoundError")
    }),
  )
})
