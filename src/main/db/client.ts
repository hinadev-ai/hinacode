import { SqliteClient } from "@effect/sql-sqlite-node"
import { Effect, Layer, String } from "effect"
import { SqlClient } from "effect/sql"
import { runMigrations } from "./migrator.ts"

const setup = Layer.effectDiscard(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`PRAGMA foreign_keys = ON`
    yield* runMigrations
  }),
)

/**
 * SQLite at `filename`, WAL on (the client's default), foreign keys on, migrations applied.
 * Columns are snake_case in SQL and camelCase in TypeScript.
 */
export const layer = (filename: string) =>
  setup.pipe(
    Layer.provideMerge(
      SqliteClient.layer({
        filename,
        transformQueryNames: String.camelToSnake,
        transformResultNames: String.snakeToCamel,
      }),
    ),
  )
