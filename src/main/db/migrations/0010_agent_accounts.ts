import { Effect } from "effect"
import { SqlClient } from "effect/sql"

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`
    CREATE TABLE agent_account (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL CHECK (provider IN ('claude', 'codex')),
      name TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `
  // No ON DELETE action: an account a thread still points at must not disappear from under it.
  yield* sql`ALTER TABLE thread ADD COLUMN account_id TEXT REFERENCES agent_account(id)`
})
