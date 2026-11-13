import { Effect } from "effect"
import { SqlClient } from "effect/sql"

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`ALTER TABLE thread_device ADD COLUMN guest INTEGER NOT NULL DEFAULT 0 CHECK (guest IN (0, 1))`
})
