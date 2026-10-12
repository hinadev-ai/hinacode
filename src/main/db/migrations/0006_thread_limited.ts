import { Effect } from "effect"
import { SqlClient } from "effect/sql"

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  // Replacing only the column avoids cascading deletes through the thread's foreign keys.
  yield* sql`ALTER TABLE thread ADD COLUMN next_status TEXT NOT NULL DEFAULT 'idle' CHECK (next_status IN ('idle', 'running', 'awaiting_approval', 'limited', 'settled', 'archived'))`
  yield* sql`UPDATE thread SET next_status = status`
  yield* sql`ALTER TABLE thread DROP COLUMN status`
  yield* sql`ALTER TABLE thread RENAME COLUMN next_status TO status`
  yield* sql`ALTER TABLE thread ADD COLUMN usage_limit TEXT`
})
