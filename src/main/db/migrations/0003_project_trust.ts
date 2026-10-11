import { Effect } from "effect"
import { SqlClient } from "effect/sql"

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  yield* sql`ALTER TABLE project ADD COLUMN trusted INTEGER NOT NULL DEFAULT 0 CHECK (trusted IN (0, 1))`
})
