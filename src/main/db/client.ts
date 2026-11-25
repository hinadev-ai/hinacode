import { chmodSync, closeSync, existsSync, openSync } from "node:fs"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { Effect, Layer, String } from "effect"
import { SqlClient } from "effect/sql"
import { runMigrations } from "./migrator.ts"

const setup = Layer.effectDiscard(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`PRAGMA foreign_keys = ON`
    yield* sql`PRAGMA synchronous = NORMAL`
    yield* runMigrations
  }),
)

const PRIVATE_FILE_MODE = 0o600

const keepFilesPrivate = (filename: string) =>
  Layer.effectDiscard(
    Effect.sync(() => {
      if (filename === ":memory:" || process.platform === "win32") return
      closeSync(openSync(filename, "a", PRIVATE_FILE_MODE))
      for (const path of [filename, `${filename}-wal`, `${filename}-shm`]) {
        if (existsSync(path)) chmodSync(path, PRIVATE_FILE_MODE)
      }
    }),
  )

export const layer = (filename: string) =>
  setup.pipe(
    Layer.provideMerge(
      SqliteClient.layer({
        filename,
        transformQueryNames: String.camelToSnake,
        transformResultNames: String.snakeToCamel,
      }).pipe(Layer.provide(keepFilesPrivate(filename))),
    ),
  )
