import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { body } from "./0008_messages_fts.ts"

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
