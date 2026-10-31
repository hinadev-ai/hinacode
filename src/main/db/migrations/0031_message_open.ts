import { Effect } from "effect"
import { SqlClient } from "effect/sql"

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`CREATE INDEX message_open ON message (thread_id) WHERE completed_at IS NULL`
})
