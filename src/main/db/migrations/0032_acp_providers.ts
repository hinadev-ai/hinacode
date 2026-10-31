import { Effect } from "effect"
import { SqlClient } from "effect/sql"

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  // FIXME: SQLite cannot change a CHECK, and rebuilding the table would cascade deletes
  for (const table of ["thread", "automation"]) {
    yield* sql.unsafe(
      `ALTER TABLE ${table} ADD COLUMN next_provider TEXT NOT NULL DEFAULT 'claude' CHECK (next_provider IN ('claude', 'codex', 'muse', 'cursor', 'opencode'))`,
    )
    yield* sql.unsafe(`UPDATE ${table} SET next_provider = provider`)
    yield* sql.unsafe(`ALTER TABLE ${table} DROP COLUMN provider`)
    yield* sql.unsafe(`ALTER TABLE ${table} RENAME COLUMN next_provider TO provider`)
  }
})
