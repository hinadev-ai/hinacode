import { Effect } from "effect"
import { SqlClient } from "effect/sql"

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`
    UPDATE thread SET status = 'archived', usage_limit = NULL
    WHERE status != 'archived' AND project_id IN (SELECT id FROM project WHERE kind = 'chats')
  `
})
