import { randomUUID } from "node:crypto"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import type { WorktreeStatus } from "../../shared/domain.ts"

export interface SeedThread {
  readonly rootPath: string
  readonly worktree?: { readonly path: string; readonly baseRef: string; readonly status: WorktreeStatus }
}

/** Inserts a project, optionally a worktree, and a thread in it. Returns the ids. */
export const seedThread = ({ rootPath, worktree }: SeedThread) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const now = new Date().toISOString()
    const projectId = randomUUID()
    const worktreeId = worktree ? randomUUID() : null
    const threadId = randomUUID()
    yield* sql`INSERT INTO project ${sql.insert({ id: projectId, name: "demo", rootPath, createdAt: now, updatedAt: now })}`
    if (worktree) {
      yield* sql`INSERT INTO worktree ${sql.insert({
        id: worktreeId,
        projectId,
        path: worktree.path,
        branch: "feature",
        baseRef: worktree.baseRef,
        status: worktree.status,
        createdAt: now,
      })}`
    }
    yield* sql`INSERT INTO thread ${sql.insert({
      id: threadId,
      projectId,
      worktreeId,
      title: "t",
      provider: "claude",
      model: "m",
      status: "idle",
      sortIndex: 0,
      createdAt: now,
      updatedAt: now,
    })}`
    return { projectId, worktreeId, threadId }
  })
