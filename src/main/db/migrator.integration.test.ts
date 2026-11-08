import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { layer } from "./client.ts"
import { runMigrations } from "./migrator.ts"

const freshDatabase = () => layer(join(mkdtempSync(join(tmpdir(), "hinacode-migrator-")), "hinacode.sqlite"))

const hasObservedStatus = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const columns = yield* sql<{ readonly name: string }>`SELECT name FROM pragma_table_info('pull_request_link')`
  return columns.some(({ name }) => name === "observed_status")
})

describe("runMigrations", () => {
  it.effect("upgrades a database that already ran the shipped migration 40", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* sql`ALTER TABLE thread ADD COLUMN user_skills INTEGER NOT NULL DEFAULT 1 CHECK (user_skills IN (0, 1))`
      yield* sql`ALTER TABLE pull_request_link DROP COLUMN observed_status`
      yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id >= 43`

      const ran = yield* runMigrations

      expect(ran).toStrictEqual([
        [43, "pull_request_observed_status"],
        [44, "drop_thread_user_skills"],
        [45, "magpie_provider"],
      ])
      expect(yield* hasObservedStatus).toBe(true)
      expect(yield* sql`SELECT name FROM effect_sql_migrations WHERE migration_id = 40`).toStrictEqual([
        { name: "remote_private_networks" },
      ])
    }).pipe(Effect.provide(freshDatabase())),
  )
})
