import { Effect } from "effect"
import { SqlClient } from "effect/sql"

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`ALTER TABLE thread ADD COLUMN access_mode TEXT NOT NULL DEFAULT 'supervised' CHECK (access_mode IN ('supervised', 'auto', 'full'))`
})
