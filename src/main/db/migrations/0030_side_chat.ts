import { Effect } from "effect"
import { SqlClient } from "effect/sql"

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`ALTER TABLE thread ADD COLUMN side_of TEXT REFERENCES thread(id) ON DELETE CASCADE`
  yield* sql`CREATE UNIQUE INDEX thread_side_of ON thread (side_of)`
})
