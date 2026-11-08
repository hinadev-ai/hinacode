import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "@effect/vitest"
import { NodeServices } from "@effect/platform-node"
import { Effect, Layer } from "effect"
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
  }).pipe(Effect.provide(Layer.mergeAll(Db.layer(":memory:"), NodeServices.layer)))

const base = mkdtempSync(join(tmpdir(), "kk-workspace-"))
afterAll(() => rmSync(base, { recursive: true, force: true }))
const root = join(base, "root")
const wt = join(base, "root-wt")
mkdirSync(root)
mkdirSync(wt)

const repoWithWorktree = () => {
  const repo = join(base, "repo")
  const worktree = join(base, "wt")
  execFileSync("git", ["init", "-q", "-b", "main", repo])
  execFileSync("git", [
    "-C",
    repo,
    "-c",
    "user.email=t@t",
    "-c",
    "user.name=t",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "init",
  ])
  execFileSync("git", ["-C", repo, "worktree", "add", "-q", "-b", "feature", worktree, "main"])
  return { repo, worktree }
}

describe("activeWorkspace", () => {
  it.effect("is the project root with no base for a thread without a worktree", () =>
    Effect.gen(function* () {
      const result = yield* resolve({ rootPath: root })
      expect(result._tag === "Success" && result.success).toStrictEqual({
        cwd: root,
        rootPath: root,
        worktreeId: null,
        baseRef: null,
        branch: null,
        worktreeRemoved: false,
      })
    }),
  )

  it.effect("is the worktree and its base while the worktree is active", () =>
    Effect.gen(function* () {
      const result = yield* resolve({ rootPath: root, worktree: { path: wt, baseRef: "main", status: "ready" } })
      expect(result._tag === "Success" && result.success).toStrictEqual({
        cwd: wt,
        rootPath: root,
        worktreeId: expect.any(String),
        baseRef: "main",
        branch: "feature",
        worktreeRemoved: false,
      })
    }),
  )

  it.effect("falls back to the project root with no base once the worktree is removed", () =>
    Effect.gen(function* () {
      const result = yield* resolve({
        rootPath: root,
        worktree: { path: wt, baseRef: "main", status: "removed" },
      })
      expect(result._tag === "Success" && result.success).toStrictEqual({
        cwd: root,
        rootPath: root,
        worktreeId: null,
        baseRef: null,
        branch: null,
        worktreeRemoved: true,
      })
    }),
  )

  it.effect("falls back to the project root when the worktree row is gone", () =>
    Effect.gen(function* () {
      const result = yield* resolve(
        { rootPath: root, worktree: { path: wt, baseRef: "main", status: "ready" } },
        (sql) => sql`DELETE FROM worktree`,
      )
      expect(result._tag === "Success" && result.success).toStrictEqual({
        cwd: root,
        rootPath: root,
        worktreeId: null,
        baseRef: null,
        branch: null,
        worktreeRemoved: false,
      })
    }),
  )

  it.effect("fails with FolderMissingError once the worktree folder is deleted on disk", () =>
    Effect.gen(function* () {
      const { repo, worktree } = repoWithWorktree()
      rmSync(worktree, { recursive: true, force: true })
      const result = yield* resolve({ rootPath: repo, worktree: { path: worktree, baseRef: "main", status: "ready" } })
      expect(result._tag === "Failure" && result.failure).toMatchObject({ _tag: "FolderMissingError", path: worktree })
    }),
  )

  it.effect("fails with NotFoundError for a deleted thread", () =>
    Effect.gen(function* () {
      const result = yield* resolve(
        { rootPath: root },
        (sql, { threadId }) => sql`DELETE FROM thread WHERE id = ${threadId}`,
      )
      expect(result._tag === "Failure" && result.failure._tag).toBe("NotFoundError")
    }),
  )
})
