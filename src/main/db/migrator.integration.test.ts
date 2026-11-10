import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { describe, expect, it } from "@effect/vitest"
import { Cause, Effect, Exit, String } from "effect"
import { Migrator, SqlClient } from "effect/sql"
import { layer } from "./client.ts"
import init from "./migrations/0001_init.ts"
import automations from "./migrations/0002_automations.ts"
import { runMigrations } from "./migrator.ts"
import { seedThread } from "./testing.ts"

const databasePath = () => join(mkdtempSync(join(tmpdir(), "hinacode-migrator-")), "hinacode.sqlite")

const freshDatabase = () => layer(databasePath())

const rawDatabase = (filename: string) =>
  SqliteClient.layer({
    filename,
    transformQueryNames: String.camelToSnake,
    transformResultNames: String.snakeToCamel,
  })

const hasObservedStatus = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const columns = yield* sql<{ readonly name: string }>`SELECT name FROM pragma_table_info('pull_request_link')`
  return columns.some(({ name }) => name === "observed_status")
})

const columnsOf = (table: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const columns = yield* sql<{ readonly name: string }>`SELECT name FROM pragma_table_info(${table})`
    return columns.map(({ name }) => name)
  })

const recordedIds = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const rows = yield* sql<{ readonly migrationId: number }>`SELECT migration_id FROM effect_sql_migrations ORDER BY 1`
  return rows.map(({ migrationId }) => migrationId)
})

const threadRow = (id: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const [row] = yield* sql<{ readonly title: string; readonly provider: string }>`
      SELECT title, provider FROM thread WHERE id = ${id}
    `
    return row
  })

const startOn = <A, E>(filename: string, effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  effect.pipe(Effect.provide(layer(filename)))

const removedProjectTrust = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`ALTER TABLE project ADD COLUMN trusted INTEGER NOT NULL DEFAULT 0 CHECK (trusted IN (0, 1))`
})

describe("runMigrations", () => {
  it.effect("upgrades a database that already ran the shipped migration 40", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* sql`ALTER TABLE thread ADD COLUMN user_skills INTEGER NOT NULL DEFAULT 1 CHECK (user_skills IN (0, 1))`
      yield* sql`ALTER TABLE pull_request_link DROP COLUMN observed_status`
      yield* sql`DROP TABLE app_connection`
      yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id >= 43`

      const ran = yield* runMigrations

      expect(ran).toStrictEqual([
        [43, "pull_request_observed_status"],
        [44, "drop_thread_user_skills"],
        [45, "magpie_provider"],
        [46, "app_connection"],
      ])
      expect(yield* hasObservedStatus).toBe(true)
      expect(yield* sql`SELECT name FROM effect_sql_migrations WHERE migration_id = 40`).toStrictEqual([
        { name: "remote_private_networks" },
      ])
    }).pipe(Effect.provide(freshDatabase())),
  )

  it.effect("upgrades a database that recorded the removed migration 3, and keeps its rows", () =>
    Effect.gen(function* () {
      const filename = databasePath()
      const { threadId } = yield* Effect.gen(function* () {
        yield* Migrator.make({})({
          loader: Migrator.fromRecord({
            "1_init": init,
            "2_automations": automations,
            "3_project_trust": removedProjectTrust,
          }),
        })
        return yield* seedThread({ rootPath: "/repo" })
      }).pipe(Effect.provide(rawDatabase(filename)))

      const upgraded = yield* startOn(
        filename,
        Effect.all({ thread: threadRow(threadId), ids: recordedIds, projectColumns: columnsOf("project") }),
      )

      expect(upgraded.thread).toStrictEqual({ title: "t", provider: "claude" })
      expect(upgraded.ids.slice(0, 4)).toStrictEqual([1, 2, 3, 4])
      expect(upgraded.ids.at(-1)).toBe(46)
      expect(upgraded.projectColumns).toContain("trusted")
    }),
  )

  it.effect("rolls back a migration that fails halfway, names it, and keeps the data", () =>
    Effect.gen(function* () {
      const filename = databasePath()
      const { threadId } = yield* startOn(
        filename,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          const seeded = yield* seedThread({ rootPath: "/repo" })
          yield* sql`UPDATE thread SET provider = 'codex' WHERE id = ${seeded.threadId}`
          yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id >= 45`
          yield* sql`ALTER TABLE automation ADD COLUMN next_provider TEXT`
          return seeded
        }),
      )

      const exit = yield* Effect.exit(startOn(filename, Effect.void))

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit))
        expect(Cause.squash(exit.cause)).toMatchObject({ message: 'Migration "45_magpie_provider" failed' })
      const after = yield* Effect.all({
        thread: threadRow(threadId),
        threadColumns: columnsOf("thread"),
        ids: recordedIds,
      }).pipe(Effect.provide(rawDatabase(filename)))
      expect(after.thread).toStrictEqual({ title: "t", provider: "codex" })
      expect(after.threadColumns).not.toContain("next_provider")
      expect(after.ids.at(-1)).toBe(44)
    }),
  )

  it.effect("starts on a database a newer HinaCode migrated, without touching its schema or rows", () =>
    Effect.gen(function* () {
      const filename = databasePath()
      const { threadId } = yield* startOn(
        filename,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          const seeded = yield* seedThread({ rootPath: "/repo" })
          yield* sql`ALTER TABLE thread ADD COLUMN from_the_future TEXT NOT NULL DEFAULT 'kept'`
          yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (47, 'from_the_future')`
          return seeded
        }),
      )

      const reopened = yield* startOn(
        filename,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          const [future] = yield* sql<{ readonly fromTheFuture: string }>`
            SELECT from_the_future FROM thread WHERE id = ${threadId}
          `
          return { ran: yield* runMigrations, thread: yield* threadRow(threadId), future, ids: yield* recordedIds }
        }),
      )

      expect(reopened).toStrictEqual({
        ran: [],
        thread: { title: "t", provider: "claude" },
        future: { fromTheFuture: "kept" },
        ids: expect.arrayContaining([46, 47]),
      })
    }),
  )
})
