import { Effect } from "effect"
import { SqlClient } from "effect/sql"

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`CREATE TABLE pull_request_guide (url TEXT PRIMARY KEY, guide TEXT NOT NULL)`
})
