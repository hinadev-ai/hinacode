import { randomUUID } from "node:crypto"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import type { ProjectKind, WorktreeStatus } from "../../shared/domain.ts"

export interface SeedThread {
  readonly rootPath: string
  readonly projectId?: string
  readonly kind?: ProjectKind
  readonly worktree?: { readonly path: string; readonly baseRef: string; readonly status: WorktreeStatus }
}

export const seedThread = ({ rootPath, projectId: existingProjectId, kind, worktree }: SeedThread) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const now = new Date().toISOString()
    const projectId = existingProjectId ?? randomUUID()
    const worktreeId = worktree ? randomUUID() : null
    const threadId = randomUUID()
    if (existingProjectId === undefined)
      yield* sql`INSERT INTO project ${sql.insert({ id: projectId, name: "demo", rootPath, ...(kind ? { kind } : {}), createdAt: now, updatedAt: now })}`
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

export const restoreAutomationTables = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`DROP TABLE routine_run`
  yield* sql`DROP TABLE routine`
  yield* sql`
    CREATE TABLE automation (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      enabled INTEGER NOT NULL,
      trigger TEXT NOT NULL,
      prompt_template TEXT NOT NULL,
      model TEXT NOT NULL,
      run_in_worktree INTEGER NOT NULL,
      branch_template TEXT,
      cursor TEXT,
      polled_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      provider TEXT NOT NULL
    )
  `
  yield* sql`
    CREATE TABLE automation_run (
      id TEXT PRIMARY KEY,
      automation_id TEXT NOT NULL REFERENCES automation(id) ON DELETE CASCADE,
      thread_id TEXT REFERENCES thread(id) ON DELETE SET NULL,
      event_key TEXT,
      payload TEXT NOT NULL,
      status TEXT NOT NULL,
      error TEXT,
      created_at TEXT NOT NULL
    )
  `
})
