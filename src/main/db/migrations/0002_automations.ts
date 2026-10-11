import { Effect } from "effect"
import { SqlClient } from "effect/sql"

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  yield* sql`ALTER TABLE thread ADD COLUMN created_by TEXT NOT NULL DEFAULT 'user'`

  yield* sql`
    CREATE TABLE automation (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
      trigger TEXT NOT NULL,
      prompt_template TEXT NOT NULL,
      provider TEXT NOT NULL CHECK (provider IN ('claude', 'codex')),
      model TEXT NOT NULL,
      run_in_worktree INTEGER NOT NULL CHECK (run_in_worktree IN (0, 1)),
      branch_template TEXT,
      cursor TEXT,
      polled_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `

  yield* sql`
    CREATE TABLE automation_run (
      id TEXT PRIMARY KEY,
      automation_id TEXT NOT NULL REFERENCES automation(id) ON DELETE CASCADE,
      thread_id TEXT REFERENCES thread(id) ON DELETE SET NULL,
      event_key TEXT,
      payload TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('started', 'skipped', 'failed')),
      error TEXT,
      created_at TEXT NOT NULL
    )
  `
  yield* sql`CREATE INDEX automation_run_recent ON automation_run(automation_id, created_at)`
  // Only a started run claims its event, so a failed run can be retried by a redelivery and a
  // skipped run can record the duplicate it rejected.
  yield* sql`
    CREATE UNIQUE INDEX automation_run_event ON automation_run(automation_id, event_key)
    WHERE status = 'started'
  `
})
