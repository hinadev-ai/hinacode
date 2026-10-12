import { SqliteClient } from "@effect/sql-sqlite-node"
import { it, expect } from "@effect/vitest"
import { Effect, String } from "effect"
import { SqlClient } from "effect/sql"
import init from "./migrations/0001_init.ts"
import automations from "./migrations/0002_automations.ts"
import effort from "./migrations/0004_thread_effort.ts"
import access from "./migrations/0005_thread_access_mode.ts"
import limited from "./migrations/0006_thread_limited.ts"
import { seedThread } from "./testing.ts"

it.effect("migrates existing thread states without deleting related data", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`PRAGMA foreign_keys = ON`
    yield* init
    yield* automations
    yield* effort
    yield* access
    const { threadId, projectId } = yield* seedThread({ rootPath: "/repo" })
    yield* sql`UPDATE thread SET status = 'awaiting_approval', provider_session_id = 'session'`
    yield* sql`INSERT INTO message (id, thread_id, role, parts, created_at) VALUES ('message', ${threadId}, 'assistant', '[]', 'now')`
    yield* sql`INSERT INTO pull_request_link (id, thread_id, url, created_at) VALUES ('pr', ${threadId}, 'https://github.com/a/b/pull/1', 'now')`
    yield* sql`INSERT INTO automation (id, project_id, name, enabled, trigger, prompt_template, provider, model, run_in_worktree, branch_template, created_at, updated_at) VALUES ('automation', ${projectId}, 'demo', 0, '{}', 'hello', 'claude', 'm', 0, NULL, 'now', 'now')`
    yield* sql`INSERT INTO automation_run (id, automation_id, thread_id, payload, status, created_at) VALUES ('run', 'automation', ${threadId}, '{}', 'started', 'now')`
    yield* sql.withTransaction(limited)
    expect(yield* sql`SELECT status, provider_session_id, usage_limit FROM thread`).toEqual([
      { status: "awaiting_approval", providerSessionId: "session", usageLimit: null },
    ])
    expect(yield* sql`SELECT thread_id FROM message`).toEqual([{ threadId }])
    expect(yield* sql`SELECT thread_id FROM pull_request_link`).toEqual([{ threadId }])
    expect(yield* sql`SELECT thread_id FROM automation_run`).toEqual([{ threadId }])
    yield* sql`UPDATE thread SET status = 'limited'`
    const invalid = yield* sql`UPDATE thread SET status = 'unknown'`.pipe(Effect.result)
    expect(invalid._tag).toBe("Failure")
  }).pipe(
    Effect.provide(
      SqliteClient.layer({
        filename: ":memory:",
        transformQueryNames: String.camelToSnake,
        transformResultNames: String.snakeToCamel,
      }),
    ),
  ),
)
