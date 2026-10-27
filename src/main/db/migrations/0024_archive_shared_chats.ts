import { Effect } from "effect"
import { SqlClient } from "effect/sql"

// Chats used to share the chats project's folder. Each now has a folder of its own that exists while it is not
// archived, so the chats that never had one are archived, and unarchiving one makes its folder.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`
    UPDATE thread SET status = 'archived', usage_limit = NULL
    WHERE status != 'archived' AND project_id IN (SELECT id FROM project WHERE kind = 'chats')
  `
})
