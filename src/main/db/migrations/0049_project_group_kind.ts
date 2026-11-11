import { Effect } from "effect"
import { SqlClient } from "effect/sql"

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  // FIXME: SQLite cannot change a CHECK, and rebuilding the table would cascade deletes
  yield* sql`DROP INDEX project_one_chats`
  yield* sql`ALTER TABLE project ADD COLUMN next_kind TEXT NOT NULL DEFAULT 'folder' CHECK (next_kind IN ('folder', 'chats', 'group'))`
  yield* sql`UPDATE project SET next_kind = kind`
  yield* sql`ALTER TABLE project DROP COLUMN kind`
  yield* sql`ALTER TABLE project RENAME COLUMN next_kind TO kind`
  yield* sql`CREATE UNIQUE INDEX project_one_chats ON project (kind) WHERE kind = 'chats'`
})
