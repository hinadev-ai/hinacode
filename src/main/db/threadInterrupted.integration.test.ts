import { expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { ThreadStatus } from "../../shared/domain.ts"
import * as Db from "./client.ts"
import { runMigrations } from "./migrator.ts"
import { seedThread } from "./testing.ts"

const SNOOZED_UNTIL = "2999-01-01T00:00:00.000Z"

const threadRows = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  return yield* sql`SELECT id, status, snoozed_until, interrupted_at FROM thread ORDER BY id`
})

it.effect("adds interrupted_at as null to threads in every status, and leaves their status and snooze alone", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`ALTER TABLE thread DROP COLUMN interrupted_at`
    yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id >= 49`
    const first = yield* seedThread({ rootPath: "/repo" })
    for (const status of ThreadStatus.literals) {
      const { threadId } =
        status === "idle" ? first : yield* seedThread({ rootPath: "/repo", projectId: first.projectId })
      yield* sql`UPDATE thread SET status = ${status}, snoozed_until = ${SNOOZED_UNTIL} WHERE id = ${threadId}`
    }
    const before = yield* sql`SELECT id, status, snoozed_until FROM thread ORDER BY id`

    expect(yield* runMigrations).toStrictEqual([[49, "thread_interrupted"]])

    expect(yield* threadRows).toStrictEqual(before.map((row) => ({ ...row, interruptedAt: null })))
    expect(before.map((row) => row.status).toSorted()).toStrictEqual(ThreadStatus.literals.toSorted())
  }).pipe(Effect.provide(Db.layer(":memory:"))),
)
