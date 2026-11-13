import { Context, Effect, Layer, Schema } from "effect"
import { SqlClient, SqlSchema } from "effect/sql"
import { UsageRow } from "../../shared/usage.ts"
import { type PersistenceError, persistence } from "./errors.ts"

export class Usage extends Context.Service<
  Usage,
  {
    readonly rows: (since: string | null) => Effect.Effect<ReadonlyArray<UsageRow>, PersistenceError>
  }
>()("hinacode/Usage") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  const findRows = SqlSchema.findAll({
    Request: Schema.NullOr(Schema.String),
    Result: UsageRow,
    execute: (since) => sql`
      WITH switch AS (
        SELECT thread_id, created_at,
          json_extract(parts, '$[0].from') AS from_provider,
          json_extract(parts, '$[0].to') AS to_provider
        FROM message
        WHERE role = 'assistant'
          AND instr(parts, '"agent_switch"') > 0
          AND json_extract(parts, '$[0].type') = 'agent_switch'
      ),
      activity AS (
        SELECT message.thread_id, message.role,
          coalesce(json_extract(message.usage, '$.inputTokens'), 0)
            + coalesce(json_extract(message.usage, '$.outputTokens'), 0) AS tokens,
          coalesce(
            (SELECT to_provider FROM switch
              WHERE switch.thread_id = message.thread_id AND switch.created_at <= message.created_at
              ORDER BY switch.created_at DESC LIMIT 1),
            (SELECT from_provider FROM switch
              WHERE switch.thread_id = message.thread_id
              ORDER BY switch.created_at LIMIT 1),
            thread.provider
          ) AS provider
        FROM message JOIN thread ON thread.id = message.thread_id
        WHERE (message.role = 'user' OR message.usage IS NOT NULL)
          AND (${since} IS NULL OR message.created_at >= ${since})
      )
      SELECT activity.thread_id, project.id AS project_id, project.name AS project_name, activity.provider,
        CASE WHEN activity.provider = thread.provider THEN thread.model END AS model,
        count(*) FILTER (WHERE activity.role = 'user') AS turns,
        sum(activity.tokens) AS tokens
      FROM activity
      JOIN thread ON thread.id = activity.thread_id
      JOIN project ON project.id = thread.project_id
      GROUP BY activity.thread_id, activity.provider
    `,
  })

  return Usage.of({
    rows: (since) => findRows(since).pipe(Effect.mapError(persistence("usage.rows"))),
  })
})

export const layer = Layer.effect(Usage, make)
