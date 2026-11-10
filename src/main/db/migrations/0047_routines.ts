import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { Effect, Predicate } from "effect"
import { SqlClient } from "effect/sql"

const readSettings = (path: string) => {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"))
    return Predicate.isObject(value) ? (value as Record<string, unknown>) : null
  } catch {
    return null
  }
}

const moveListenerSetting = (path: string) => {
  const settings = existsSync(path) ? readSettings(path) : null
  if (settings === null || !("automations" in settings)) return
  const { automations, ...rest } = settings
  const temp = `${path}.tmp`
  writeFileSync(temp, `${JSON.stringify({ ...rest, routines: rest["routines"] ?? automations }, null, 2)}\n`)
  renameSync(temp, path)
}

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  yield* sql`
    CREATE TABLE routine (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
      prompt TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      effort TEXT,
      workspace TEXT NOT NULL CHECK (workspace IN ('local', 'worktree')),
      schedule TEXT,
      next_run_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `
  yield* sql`
    CREATE TABLE routine_run (
      id TEXT PRIMARY KEY,
      routine_id TEXT NOT NULL REFERENCES routine(id) ON DELETE CASCADE,
      thread_id TEXT REFERENCES thread(id) ON DELETE SET NULL,
      source TEXT NOT NULL CHECK (source IN ('schedule', 'webhook', 'manual')),
      event_key TEXT,
      payload TEXT,
      status TEXT NOT NULL CHECK (status IN ('started', 'skipped', 'failed')),
      error TEXT,
      created_at TEXT NOT NULL
    )
  `
  yield* sql`CREATE INDEX routine_run_recent ON routine_run(routine_id, created_at)`
  yield* sql`
    CREATE UNIQUE INDEX routine_run_event ON routine_run(routine_id, event_key)
    WHERE status = 'started' AND event_key IS NOT NULL
  `

  yield* sql`
    INSERT INTO routine (id, project_id, name, enabled, prompt, provider, model, effort, workspace, schedule, next_run_at, created_at, updated_at)
    SELECT id, project_id, name, 0, prompt_template, provider, model, NULL,
           CASE run_in_worktree WHEN 1 THEN 'worktree' ELSE 'local' END,
           NULL, NULL, created_at, updated_at
    FROM automation
  `
  yield* sql`DROP TABLE automation_run`
  yield* sql`DROP TABLE automation`
  yield* sql`DELETE FROM setting WHERE key LIKE 'secret.automation.%' OR key = 'secret.slack.token'`

  const [main] = yield* sql<{ readonly file: string }>`SELECT file FROM pragma_database_list WHERE name = 'main'`
  if (main?.file) moveListenerSetting(join(dirname(main.file), "settings.json"))
})
