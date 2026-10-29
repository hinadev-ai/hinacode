import { existsSync, renameSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"

const SETTINGS_KEYS = [
  "defaultProvider",
  "defaultModel",
  "defaultEffort",
  "defaultFastMode",
  "defaultWorkspaceMode",
  "modelPresets",
  "defaultAccount",
  "defaultAccountName",
  "autoCompactTokens",
  "automations",
  "remote",
  "textGenerationModel",
  "pullRequestGuide",
  "defaultAccessMode",
  "archive",
  "experimental",
  "worktreeRoot",
]
const CLIENT_SETTINGS_KEYS = ["locale", "openWith", "appearance", "notifications", "sidebarGroups"]

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  // The settings files sit next to the database, whose path is the only place a migration can learn that directory from.
  const [main] = yield* sql<{ readonly file: string }>`SELECT file FROM pragma_database_list WHERE name = 'main'`
  // An in-memory database is new, so it has no setting rows to move.
  if (!main?.file) return
  const dir = dirname(main.file)

  const move = (file: string, keys: ReadonlyArray<string>, contents: (rows: Map<string, unknown>) => unknown) =>
    Effect.gen(function* () {
      const path = join(dir, file)
      if (existsSync(path)) return
      const rows = yield* sql<{ readonly key: string; readonly value: string }>`
        SELECT key, value FROM setting WHERE ${sql.in("key", keys)}
      `
      if (rows.length === 0) return
      const temp = `${path}.tmp`
      writeFileSync(
        temp,
        `${JSON.stringify(contents(new Map(rows.map((row) => [row.key, JSON.parse(row.value) as unknown]))), null, 2)}\n`,
      )
      renameSync(temp, path)
      yield* sql`DELETE FROM setting WHERE ${sql.in("key", keys)}`
    })

  yield* move("settings.json", SETTINGS_KEYS, Object.fromEntries)
  yield* move("client-settings.json", CLIENT_SETTINGS_KEYS, Object.fromEntries)
  yield* move("keybindings.json", ["keybindings"], (rows) => rows.get("keybindings"))
})
