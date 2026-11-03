import { Effect } from "effect"
import { SqlClient } from "effect/sql"

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`
    CREATE TABLE message_part (
      message_id TEXT NOT NULL REFERENCES message(id) ON DELETE CASCADE,
      idx INTEGER NOT NULL,
      part TEXT NOT NULL,
      PRIMARY KEY (message_id, idx)
    )
  `
  yield* sql`
    INSERT INTO message_part (message_id, idx, part)
    SELECT message.id, part.key, part.value
    FROM message, json_each(message.parts) AS part
    WHERE message.completed_at IS NULL
  `
  yield* sql`UPDATE message SET parts = '[]' WHERE completed_at IS NULL`
})
