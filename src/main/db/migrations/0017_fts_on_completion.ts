import { Effect } from "effect"
import { SqlClient } from "effect/sql"

const body = (parts: string) => `(
  SELECT group_concat(CASE json_extract(value, '$.type')
    WHEN 'text' THEN json_extract(value, '$.text')
    WHEN 'tool_call' THEN json_extract(value, '$.name') || char(10) || coalesce(
      json_extract(value, '$.input.command'),
      json_extract(value, '$.input.file_path'),
      json_extract(value, '$.input.notebook_path'),
      json_extract(value, '$.input.pattern'),
      json_extract(value, '$.input.path'),
      json_extract(value, '$.input.url'),
      json_extract(value, '$.input.query'),
      json_extract(value, '$.input.description'),
      json_extract(value, '$.input'),
      ''
    )
    WHEN 'file_change' THEN json_extract(value, '$.path')
  END, char(10))
  FROM json_each(${parts})
)`

/**
 * A streaming turn rewrites its assistant message's parts on every persist, and re-indexing the whole
 * body each time cost as much as the write itself. Index a message once it completes instead: a steer,
 * the end of a turn and `Messages.closeInterrupted` all write the row with `completed_at` set.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`DROP TRIGGER message_fts_update`
  yield* sql.unsafe(`
    CREATE TRIGGER message_fts_update AFTER UPDATE OF parts ON message WHEN new.completed_at IS NOT NULL BEGIN
      UPDATE message_fts SET body = ${body("new.parts")} WHERE rowid = new.rowid;
    END
  `)
})
