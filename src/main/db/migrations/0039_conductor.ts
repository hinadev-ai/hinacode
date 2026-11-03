import { Effect } from "effect"
import { SqlClient } from "effect/sql"

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`ALTER TABLE thread ADD COLUMN conductor INTEGER NOT NULL DEFAULT 0`
  yield* sql`CREATE UNIQUE INDEX thread_one_conductor ON thread (conductor) WHERE conductor = 1`
})
