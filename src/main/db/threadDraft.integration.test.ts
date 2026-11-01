import { expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import * as Db from "./client.ts"
import threadDraft from "./migrations/0033_thread_draft.ts"
import { seedThread } from "./testing.ts"

it.effect("allows the draft status and keeps every thread's state and related rows", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const { threadId } = yield* seedThread({ rootPath: "/repo" })
    yield* sql`UPDATE thread SET status = 'awaiting_approval'`
    yield* sql`INSERT INTO message (id, thread_id, role, parts, created_at) VALUES ('message', ${threadId}, 'user', '[]', 'now')`
    yield* sql`INSERT INTO pull_request_link (id, thread_id, url, created_at) VALUES ('pr', ${threadId}, 'https://github.com/a/b/pull/1', 'now')`

    yield* sql.withTransaction(threadDraft)

    expect(yield* sql`SELECT status FROM thread`).toEqual([{ status: "awaiting_approval" }])
    expect(yield* sql`SELECT thread_id FROM message`).toEqual([{ threadId }])
    expect(yield* sql`SELECT thread_id FROM pull_request_link`).toEqual([{ threadId }])
    yield* sql`UPDATE thread SET status = 'draft'`
    const invalid = yield* sql`UPDATE thread SET status = 'settled'`.pipe(Effect.result)
    expect(invalid._tag).toBe("Failure")
  }).pipe(Effect.provide(Db.layer(":memory:"))),
)
