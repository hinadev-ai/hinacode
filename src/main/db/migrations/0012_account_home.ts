import { dirname, join } from "node:path"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`ALTER TABLE agent_account ADD COLUMN config_dir TEXT NOT NULL DEFAULT ''`
  yield* sql`ALTER TABLE agent_account ADD COLUMN binary TEXT NOT NULL DEFAULT ''`
  yield* sql`UPDATE agent_account SET binary = provider`
  const [main] = yield* sql<{ readonly file: string }>`SELECT file FROM pragma_database_list WHERE name = 'main'`
  if (!main?.file) return
  const root = join(dirname(main.file), "accounts")
  const accounts = yield* sql<{ readonly id: string }>`SELECT id FROM agent_account`
  for (const { id } of accounts) {
    yield* sql`UPDATE agent_account SET config_dir = ${join(root, id)} WHERE id = ${id}`
  }
})
