import { randomUUID } from "node:crypto"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { defaultClientSettings } from "../../src/shared/domain.ts"

const writeJson = (path: string, value: unknown) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)

export const SEEDED_AT = "2026-01-01T00:00:00.000Z"

export interface SeedProject {
  readonly name: string
  readonly rootPath: string
  readonly setupScript?: string | null
}

export interface SeedThread {
  readonly projectId: string
  readonly title: string
  readonly provider?: "claude" | "codex"
  readonly worktreeId?: string | null
  readonly status?: "idle" | "running"
}

export class Seed {
  readonly #dbPath: string

  constructor(dbPath: string) {
    this.#dbPath = dbPath
  }

  #with<T>(run: (db: DatabaseSync) => T): T {
    const db = new DatabaseSync(this.#dbPath)
    try {
      return run(db)
    } finally {
      db.close()
    }
  }

  project({ name, rootPath, setupScript = null }: SeedProject): string {
    const id = randomUUID()
    this.#with((db) =>
      db
        .prepare(
          `INSERT INTO project (id, name, root_path, setup_script, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(id, name, rootPath, setupScript, SEEDED_AT, SEEDED_AT),
    )
    return id
  }

  thread({ projectId, title, provider = "claude", worktreeId = null, status = "idle" }: SeedThread): string {
    const id = randomUUID()
    this.#with((db) =>
      db
        .prepare(
          `INSERT INTO thread (id, project_id, worktree_id, title, provider, model, provider_session_id, status, sort_index, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'claude-sonnet-5-5', NULL, ?,
                   (SELECT COALESCE(MAX(sort_index) + 1, 0) FROM thread WHERE project_id = ?), ?, ?)`,
        )
        .run(id, projectId, worktreeId, title, provider, status, projectId, SEEDED_AT, SEEDED_AT),
    )
    return id
  }

  setting(key: string, value: unknown): void {
    const dir = dirname(this.#dbPath)
    if (key === "keybindings") return writeJson(join(dir, "keybindings.json"), value)
    const path = join(dir, key in defaultClientSettings ? "client-settings.json" : "settings.json")
    const stored = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>) : {}
    writeJson(path, { ...stored, [key]: value })
  }
}
