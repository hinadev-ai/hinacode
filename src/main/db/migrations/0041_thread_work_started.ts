import { Effect } from "effect"
import { SqlClient } from "effect/sql"

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`ALTER TABLE thread ADD COLUMN work_started_at TEXT`
  yield* sql`
    UPDATE thread SET work_started_at = (
      SELECT MAX(message.created_at) FROM message WHERE message.thread_id = thread.id AND message.role = 'user'
    )
  `
})
