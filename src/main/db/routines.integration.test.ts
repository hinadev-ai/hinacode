import { expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import * as Db from "./client.ts"
import routines from "./migrations/0047_routines.ts"
import { restoreAutomationTables, seedThread } from "./testing.ts"

it.effect("copies each automation into a disabled routine with no schedule and drops the automation tables", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* restoreAutomationTables
    const { projectId, threadId } = yield* seedThread({ rootPath: "/repo" })
    yield* sql`INSERT INTO automation (id, project_id, name, enabled, trigger, prompt_template, provider, model, run_in_worktree, branch_template, created_at, updated_at) VALUES
      ('linear', ${projectId}, 'Triage', 1, '{"type":"linear.issue","teamKey":"KAL"}', 'Look at {{issue.title}}', 'codex', 'gpt', 1, 'kk/x', 'c', 'u'),
      ('hook', ${projectId}, 'Hook', 0, '{"type":"webhook"}', 'Deploy', 'magpie', 'm', 0, NULL, 'c2', 'u2')`
    yield* sql`INSERT INTO automation_run (id, automation_id, thread_id, payload, status, created_at) VALUES ('run', 'linear', ${threadId}, '{}', 'started', 'now')`

    yield* sql.withTransaction(routines)

    expect(yield* sql`SELECT * FROM routine ORDER BY id`).toStrictEqual([
      {
        id: "hook",
        projectId,
        name: "Hook",
        enabled: 0,
        prompt: "Deploy",
        provider: "magpie",
        model: "m",
        effort: null,
        workspace: "local",
        schedule: null,
        nextRunAt: null,
        createdAt: "c2",
        updatedAt: "u2",
      },
      {
        id: "linear",
        projectId,
        name: "Triage",
        enabled: 0,
        prompt: "Look at {{issue.title}}",
        provider: "codex",
        model: "gpt",
        effort: null,
        workspace: "worktree",
        schedule: null,
        nextRunAt: null,
        createdAt: "c",
        updatedAt: "u",
      },
    ])
    expect(yield* sql`SELECT name FROM sqlite_master WHERE name LIKE 'automation%'`).toStrictEqual([])
    expect(yield* sql`SELECT id FROM thread`).toStrictEqual([{ id: threadId }])
  }).pipe(Effect.provide(Db.layer(":memory:"))),
)
