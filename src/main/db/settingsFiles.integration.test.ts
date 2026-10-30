import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { expect, it } from "@effect/vitest"
import { Effect, String } from "effect"
import { SqlClient } from "effect/sql"
import init from "./migrations/0001_init.ts"
import settingsFiles from "./migrations/0027_settings_files.ts"

const dir = mkdtempSync(join(tmpdir(), "kk-settings-migration-"))
const readJson = (file: string) => JSON.parse(readFileSync(join(dir, file), "utf8")) as unknown

it.effect("moves setting rows into the files next to the database and keeps secrets and existing files", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* init
    const rows = {
      archive: { whenMerged: true },
      worktreeRoot: "/worktrees",
      locale: "ja",
      appearance: { theme: "dark" },
      keybindings: { "thread.new": "mod+shift+n" },
    }
    for (const [key, value] of Object.entries(rows)) {
      yield* sql`INSERT INTO setting (key, value) VALUES (${key}, ${JSON.stringify(value)})`
    }
    yield* sql`INSERT INTO setting (key, value) VALUES ('secret.linear', 'sealed')`
    writeFileSync(join(dir, "client-settings.json"), `{ "locale": "zh-TW" }`)

    yield* sql.withTransaction(settingsFiles)

    expect(readJson("settings.json")).toEqual({ archive: { whenMerged: true }, worktreeRoot: "/worktrees" })
    expect(readJson("keybindings.json")).toEqual({ "thread.new": "mod+shift+n" })
    expect(readJson("client-settings.json")).toEqual({ locale: "zh-TW" })
    expect(yield* sql`SELECT key FROM setting ORDER BY key`).toEqual([
      { key: "appearance" },
      { key: "locale" },
      { key: "secret.linear" },
    ])
  }).pipe(
    Effect.provide(
      SqliteClient.layer({
        filename: join(dir, "hinacode.sqlite"),
        transformQueryNames: String.camelToSnake,
        transformResultNames: String.snakeToCamel,
      }),
    ),
  ),
)
