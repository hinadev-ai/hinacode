import { Effect } from "effect"
import { SqlClient } from "effect/sql"

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  yield* sql`
    CREATE TABLE project (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      root_path TEXT NOT NULL UNIQUE,
      setup_script TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `

  yield* sql`
    CREATE TABLE worktree (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
      path TEXT NOT NULL UNIQUE,
      branch TEXT NOT NULL,
      base_ref TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('preparing', 'ready', 'failed', 'removed')),
      setup_log TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    )
  `

  yield* sql`
    CREATE TABLE thread (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
      worktree_id TEXT REFERENCES worktree(id) ON DELETE SET NULL,
      title TEXT NOT NULL,
      provider TEXT NOT NULL CHECK (provider IN ('claude', 'codex')),
      model TEXT NOT NULL,
      provider_session_id TEXT,
      status TEXT NOT NULL CHECK (status IN ('idle', 'running', 'awaiting_approval', 'settled', 'archived')),
      sort_index INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `
  yield* sql`CREATE INDEX thread_project_sort ON thread(project_id, sort_index)`

  yield* sql`
    CREATE TABLE message (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL REFERENCES thread(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
      parts TEXT NOT NULL,
      created_at TEXT NOT NULL,
      completed_at TEXT,
      usage TEXT
    )
  `
  yield* sql`CREATE INDEX message_thread_created ON message(thread_id, created_at)`

  yield* sql`
    CREATE TABLE pull_request_link (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL REFERENCES thread(id) ON DELETE CASCADE,
      url TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE (thread_id, url)
    )
  `

  yield* sql`
    CREATE TABLE setting (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `
})
