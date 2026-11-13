import { Effect } from "effect"
import { SqlClient } from "effect/sql"

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`ALTER TABLE thread_device ADD COLUMN client_id TEXT`
  yield* sql`ALTER TABLE thread_device ADD COLUMN client_name TEXT`
  yield* sql`ALTER TABLE thread_device ADD COLUMN claimed_at INTEGER`
})
