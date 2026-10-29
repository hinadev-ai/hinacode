import { Effect } from "effect"
import { SqlClient } from "effect/sql"

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  // FIXME: SQLite cannot change a CHECK, and rebuilding the table would cascade deletes
  yield* sql`ALTER TABLE thread ADD COLUMN next_provider TEXT NOT NULL DEFAULT 'claude' CHECK (next_provider IN ('claude', 'codex', 'muse'))`
  yield* sql`UPDATE thread SET next_provider = provider`
  yield* sql`ALTER TABLE thread DROP COLUMN provider`
  yield* sql`ALTER TABLE thread RENAME COLUMN next_provider TO provider`
  yield* sql`ALTER TABLE automation ADD COLUMN next_provider TEXT NOT NULL DEFAULT 'claude' CHECK (next_provider IN ('claude', 'codex', 'muse'))`
  yield* sql`UPDATE automation SET next_provider = provider`
  yield* sql`ALTER TABLE automation DROP COLUMN provider`
  yield* sql`ALTER TABLE automation RENAME COLUMN next_provider TO provider`
})
