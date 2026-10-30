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
