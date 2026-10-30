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

// FIXME: FTS5 evaluates LIKE against stored values, so the body cannot be contentless
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`CREATE VIRTUAL TABLE message_fts USING fts5(body, tokenize = 'trigram')`
  yield* sql.unsafe(`INSERT INTO message_fts(rowid, body) SELECT rowid, ${body("parts")} FROM message`)
  yield* sql.unsafe(`
    CREATE TRIGGER message_fts_insert AFTER INSERT ON message BEGIN
      INSERT INTO message_fts(rowid, body) VALUES (new.rowid, ${body("new.parts")});
    END
  `)
  yield* sql.unsafe(`
    CREATE TRIGGER message_fts_update AFTER UPDATE OF parts ON message BEGIN
      UPDATE message_fts SET body = ${body("new.parts")} WHERE rowid = new.rowid;
    END
  `)
  yield* sql`
    CREATE TRIGGER message_fts_delete AFTER DELETE ON message BEGIN
      DELETE FROM message_fts WHERE rowid = old.rowid;
    END
  `
})
