import { Effect } from "effect"
import { SqlClient } from "effect/sql"

const SUMMARY_KEYS = ["command", "file_path", "notebook_path", "pattern", "path", "url", "query", "description"]

const summary = (input: string) =>
  `coalesce(${SUMMARY_KEYS.map(
    (key) => `CASE json_type(value, '${input}.${key}') WHEN 'text' THEN json_extract(value, '${input}.${key}') END`,
  ).join(", ")})`

const body = (parts: string) => `(
  SELECT group_concat(CASE json_extract(value, '$.type')
    WHEN 'text' THEN json_extract(value, '$.text')
    WHEN 'tool_call' THEN CASE json_extract(value, '$.input.type')
      WHEN 'mcpToolCall' THEN json_extract(value, '$.input.server') || '/' || json_extract(value, '$.input.tool')
        || coalesce(char(10) || ${summary("$.input.arguments")}, '')
      ELSE json_extract(value, '$.name') || coalesce(char(10) || ${summary("$.input")}, '')
    END
    WHEN 'file_change' THEN json_extract(value, '$.path')
  END, char(10))
  FROM json_each(${parts})
)`

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`DROP TRIGGER message_fts_insert`
  yield* sql`DROP TRIGGER message_fts_update`
  yield* sql.unsafe(`
    CREATE TRIGGER message_fts_insert AFTER INSERT ON message BEGIN
      INSERT INTO message_fts(rowid, body) VALUES (new.rowid, ${body("new.parts")});
    END
  `)
  yield* sql.unsafe(`
    CREATE TRIGGER message_fts_update AFTER UPDATE OF parts ON message WHEN new.completed_at IS NOT NULL BEGIN
      UPDATE message_fts SET body = ${body("new.parts")} WHERE rowid = new.rowid;
    END
  `)
  yield* sql.unsafe(`
    UPDATE message_fts SET body = (SELECT ${body("m.parts")} FROM message m WHERE m.rowid = message_fts.rowid)
    WHERE rowid IN (SELECT rowid FROM message WHERE parts LIKE '%"tool_call"%')
  `)
})
