import { Effect } from "effect"
import { SqlClient } from "effect/sql"

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`ALTER TABLE thread ADD COLUMN user_skills INTEGER NOT NULL DEFAULT 1 CHECK (user_skills IN (0, 1))`
})
