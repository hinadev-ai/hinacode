import { Effect } from "effect"
import { SqlClient } from "effect/sql"

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`ALTER TABLE environment ADD COLUMN source TEXT NOT NULL DEFAULT 'pairing' CHECK (source IN ('pairing', 'relay'))`
})
