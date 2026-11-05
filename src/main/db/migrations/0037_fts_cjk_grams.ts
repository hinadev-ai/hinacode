import { Effect } from "effect"
import { SqlClient } from "effect/sql"

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`
    CREATE VIRTUAL TABLE message_cjk USING fts5(
      grams, content = '', contentless_delete = 1, tokenize = 'unicode61 remove_diacritics 0'
    )
  `
  yield* sql`CREATE TABLE message_cjk_stale (rowid INTEGER PRIMARY KEY)`
  yield* sql`INSERT INTO message_cjk_stale SELECT rowid FROM message`
  yield* sql`
    CREATE TRIGGER message_cjk_insert AFTER INSERT ON message BEGIN
      INSERT OR IGNORE INTO message_cjk_stale VALUES (new.rowid);
    END
  `
  yield* sql`
    CREATE TRIGGER message_cjk_update AFTER UPDATE OF parts ON message WHEN new.completed_at IS NOT NULL BEGIN
      INSERT OR IGNORE INTO message_cjk_stale VALUES (new.rowid);
    END
  `
  yield* sql`
    CREATE TRIGGER message_cjk_delete AFTER DELETE ON message BEGIN
      DELETE FROM message_cjk WHERE rowid = old.rowid;
      DELETE FROM message_cjk_stale WHERE rowid = old.rowid;
    END
  `
})
