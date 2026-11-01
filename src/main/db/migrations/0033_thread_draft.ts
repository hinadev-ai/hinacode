import { Effect } from "effect"
import { SqlClient } from "effect/sql"

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  // FIXME: SQLite rebuilding the table would cascade deletes through its foreign keys
  yield* sql`ALTER TABLE thread ADD COLUMN next_status TEXT NOT NULL DEFAULT 'idle' CHECK (next_status IN ('draft', 'idle', 'running', 'awaiting_approval', 'limited', 'archived'))`
  yield* sql`UPDATE thread SET next_status = CASE status WHEN 'settled' THEN 'archived' ELSE status END`
  yield* sql`ALTER TABLE thread DROP COLUMN status`
  yield* sql`ALTER TABLE thread RENAME COLUMN next_status TO status`
})
