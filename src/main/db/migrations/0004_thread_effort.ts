import { Effect } from "effect"
import { SqlClient } from "effect/sql"

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`ALTER TABLE thread ADD COLUMN effort TEXT`
  yield* sql`ALTER TABLE thread ADD COLUMN fast_mode INTEGER NOT NULL DEFAULT 0 CHECK (fast_mode IN (0, 1))`
})
