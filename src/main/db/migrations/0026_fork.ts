import { Effect } from "effect"
import { SqlClient } from "effect/sql"

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`ALTER TABLE thread ADD COLUMN forked_from TEXT`
  yield* sql`ALTER TABLE message ADD COLUMN fork_point TEXT`
})
