import { Effect } from "effect"
import { SqlClient } from "effect/sql"

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`ALTER TABLE project ADD COLUMN kind TEXT NOT NULL DEFAULT 'folder' CHECK (kind IN ('folder', 'chats'))`
  yield* sql`CREATE UNIQUE INDEX project_one_chats ON project (kind) WHERE kind = 'chats'`
})
