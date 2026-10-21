import { Effect } from "effect"
import { SqlClient } from "effect/sql"

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`ALTER TABLE project ADD COLUMN linear_review INTEGER NOT NULL DEFAULT 0 CHECK (linear_review IN (0, 1))`
})
