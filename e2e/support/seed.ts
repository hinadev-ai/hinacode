import { randomUUID } from "node:crypto"
import { DatabaseSync } from "node:sqlite"

export interface SeedProject {
  readonly name: string
  readonly rootPath: string
}

export interface SeedThread {
  readonly projectId: string
  readonly title: string
  readonly provider?: "claude" | "codex"
  readonly status?: "idle" | "running"
}

/**
 * Writes rows straight into the app's SQLite file for preconditions that are not under test.
 * The renderer only notices them after `app.reload()` or `app.restart()`.
 */
export class Seed {
  readonly #dbPath: string

  constructor(dbPath: string) {
    this.#dbPath = dbPath
  }

  // Open and close per call so each write commits before the app's own connection reads.
  #with<T>(run: (db: DatabaseSync) => T): T {
    const db = new DatabaseSync(this.#dbPath)
    try {
      return run(db)
    } finally {
      db.close()
    }
  }

  project({ name, rootPath }: SeedProject): string {
    const id = randomUUID()
    const now = new Date().toISOString()
    this.#with((db) =>
      db
        .prepare(
          `INSERT INTO project (id, name, root_path, setup_script, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, ?)`,
        )
        .run(id, name, rootPath, now, now),
    )
    return id
  }

  thread({ projectId, title, provider = "claude", status = "idle" }: SeedThread): string {
    const id = randomUUID()
    const now = new Date().toISOString()
    this.#with((db) =>
      db
        .prepare(
          `INSERT INTO thread (id, project_id, worktree_id, title, provider, model, provider_session_id, status, sort_index, created_at, updated_at)
           VALUES (?, ?, NULL, ?, ?, 'claude-sonnet-5-5', NULL, ?,
                   (SELECT COALESCE(MAX(sort_index) + 1, 0) FROM thread WHERE project_id = ?), ?, ?)`,
        )
        .run(id, projectId, title, provider, status, projectId, now, now),
    )
    return id
  }

  /** Stores one settings key the way `Settings.set` does: as JSON. */
  setting(key: string, value: unknown): void {
    this.#with((db) =>
      db
        .prepare(
          `INSERT INTO setting (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
        )
        .run(key, JSON.stringify(value)),
    )
  }
}
