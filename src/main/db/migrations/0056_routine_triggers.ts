import { Effect } from "effect"
import { SqlClient } from "effect/sql"

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  yield* sql`ALTER TABLE routine ADD COLUMN trigger TEXT`

  yield* sql`
    CREATE TABLE routine_run_next (
      id TEXT PRIMARY KEY,
      routine_id TEXT NOT NULL REFERENCES routine(id) ON DELETE CASCADE,
      thread_id TEXT REFERENCES thread(id) ON DELETE SET NULL,
      source TEXT NOT NULL CHECK (source IN ('schedule', 'webhook', 'manual', 'event')),
      event_key TEXT,
      payload TEXT,
      status TEXT NOT NULL CHECK (status IN ('started', 'skipped', 'failed')),
      error TEXT,
      created_at TEXT NOT NULL
    )
  `
  yield* sql`INSERT INTO routine_run_next SELECT id, routine_id, thread_id, source, event_key, payload, status, error, created_at FROM routine_run`
  yield* sql`DROP TABLE routine_run`
  yield* sql`ALTER TABLE routine_run_next RENAME TO routine_run`
  yield* sql`CREATE INDEX routine_run_recent ON routine_run(routine_id, created_at)`
  yield* sql`
    CREATE UNIQUE INDEX routine_run_event ON routine_run(routine_id, event_key)
    WHERE status = 'started' AND event_key IS NOT NULL
  `

  yield* sql`
    CREATE TABLE routine_conversation (
      routine_id TEXT NOT NULL REFERENCES routine(id) ON DELETE CASCADE,
      key TEXT NOT NULL,
      thread_id TEXT NOT NULL UNIQUE REFERENCES thread(id) ON DELETE CASCADE,
      destination TEXT NOT NULL,
      PRIMARY KEY (routine_id, key)
    )
  `
})
