import { Context, Effect, Layer, Option, Schema } from "effect"
import { SqlClient, SqlSchema } from "effect/sql"
import { ForkPoint, TokenUsage } from "../../shared/agent.ts"
import { Message, MessagePart } from "../../shared/domain.ts"
import { failRunningParts } from "../../shared/foldEvent.ts"
import { nowIso } from "./clock.ts"
import { type PersistenceError, persistence } from "./errors.ts"

const MessageRow = Schema.Struct({
  ...Message.fields,
  parts: Schema.fromJsonString(Schema.Array(MessagePart)),
  usage: Schema.NullOr(Schema.fromJsonString(TokenUsage)),
  forkPoint: Schema.NullOr(Schema.fromJsonString(ForkPoint)),
})

export interface ToolCallRef {
  readonly threadId: string
  readonly messageId?: string | undefined
  readonly callId: string
}

export class Messages extends Context.Service<
  Messages,
  {
    readonly list: (threadId: string) => Effect.Effect<ReadonlyArray<Message>, PersistenceError>
    readonly has: (id: string) => Effect.Effect<boolean, PersistenceError>
    readonly toolOutput: (call: ToolCallRef) => Effect.Effect<Option.Option<unknown>, PersistenceError>
    readonly insert: (message: Message) => Effect.Effect<void, PersistenceError>
    readonly update: (
      message: Message,
      previous: Message,
    ) => Effect.Effect<{ readonly bytes: number }, PersistenceError>
    readonly closeInterrupted: Effect.Effect<void, PersistenceError>
  }
>()("hinacode/Messages") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const encodeRow = Schema.encodeEffect(MessageRow)
  const encodePart = Schema.encodeEffect(Schema.fromJsonString(MessagePart))

  const messageColumns = sql.literal(`
    message.id, message.thread_id, message.role, message.created_at, message.completed_at, message.usage, message.fork_point,
    coalesce(
      (SELECT '[' || group_concat(part, ',' ORDER BY idx) || ']' FROM message_part WHERE message_id = message.id),
      message.parts
    ) AS parts
  `)

  const findByThread = SqlSchema.findAll({
    Request: Schema.String,
    Result: MessageRow,
    execute: (threadId) =>
      sql`SELECT ${messageColumns} FROM message WHERE thread_id = ${threadId} ORDER BY created_at, rowid`,
  })

  const findToolOutput = SqlSchema.findOneOption({
    Request: Schema.Struct({
      threadId: Schema.String,
      messageId: Schema.optional(Schema.String),
      callId: Schema.String,
    }),
    Result: Schema.Struct({ output: Schema.fromJsonString(Schema.Unknown) }),
    execute: ({ threadId, messageId, callId }) => {
      const inMessage = messageId === undefined ? sql.literal("") : sql`AND message.id = ${messageId}`
      return sql`
      SELECT part.value -> '$.output' AS output
      FROM message, json_each(message.parts) AS part
      WHERE message.thread_id = ${threadId}
        ${inMessage}
        AND json_extract(part.value, '$.type') = 'tool_call'
        AND json_extract(part.value, '$.callId') = ${callId}
        AND part.value -> '$.output' IS NOT NULL
      UNION ALL
      SELECT message_part.part -> '$.output' AS output
      FROM message JOIN message_part ON message_part.message_id = message.id
      WHERE message.thread_id = ${threadId}
        ${inMessage}
        AND json_extract(message_part.part, '$.type') = 'tool_call'
        AND json_extract(message_part.part, '$.callId') = ${callId}
        AND message_part.part -> '$.output' IS NOT NULL
    `
    },
  })

  const findInterrupted = SqlSchema.findAll({
    Request: Schema.Void,
    Result: MessageRow,
    execute: () => sql`
      SELECT ${messageColumns} FROM message
      WHERE role = 'assistant'
      AND thread_id IN (
        SELECT id FROM thread WHERE status IN ('running', 'awaiting_approval', 'limited')
        UNION SELECT thread_id FROM message WHERE completed_at IS NULL
      )
      AND (
        completed_at IS NULL OR EXISTS (
          SELECT 1 FROM json_each(message.parts)
          WHERE json_extract(value, '$.type') = 'tool_call' AND json_extract(value, '$.status') = 'running'
        )
      )
    `,
  })

  const saveOpenParts = (message: Message, previous: Message) =>
    Effect.gen(function* () {
      const rows = yield* Effect.forEach(
        message.parts.flatMap((part, idx) => (part === previous.parts[idx] ? [] : [{ part, idx }])),
        ({ part, idx }) => encodePart(part).pipe(Effect.map((json) => ({ messageId: message.id, idx, part: json }))),
      )
      if (rows.length > 0) yield* sql`INSERT OR REPLACE INTO message_part ${sql.insert(rows)}`
      if (message.parts.length < previous.parts.length) {
        yield* sql`DELETE FROM message_part WHERE message_id = ${message.id} AND idx >= ${message.parts.length}`
      }
      return { bytes: rows.reduce((total, row) => total + row.part.length, 0) }
    })

  const saveClosed = (message: Message) =>
    encodeRow(message).pipe(
      Effect.flatMap((row) =>
        sql`
          UPDATE message
          SET parts = ${row.parts}, completed_at = ${row.completedAt}, usage = ${row.usage}, fork_point = ${row.forkPoint}
          WHERE id = ${row.id}
        `.pipe(
          Effect.andThen(sql`DELETE FROM message_part WHERE message_id = ${row.id}`),
          sql.withTransaction,
          Effect.as({ bytes: row.parts.length }),
        ),
      ),
    )

  const update = (message: Message, previous: Message) =>
    (message.completedAt === null ? saveOpenParts(message, previous) : saveClosed(message)).pipe(
      Effect.mapError(persistence("messages.update")),
    )

  const insertOpen = (message: Message) => {
    const empty = { ...message, parts: [] }
    return encodeRow(empty).pipe(
      Effect.flatMap((row) => sql`INSERT INTO message ${sql.insert(row)}`),
      Effect.andThen(saveOpenParts(message, empty)),
      sql.withTransaction,
      Effect.asVoid,
    )
  }

  const insertClosed = (message: Message) =>
    encodeRow(message).pipe(
      Effect.flatMap((row) => sql`INSERT INTO message ${sql.insert(row)}`),
      Effect.asVoid,
    )

  const closeInterrupted = Effect.gen(function* () {
    const now = yield* nowIso
    const interrupted = yield* findInterrupted(undefined).pipe(
      Effect.mapError(persistence("messages.closeInterrupted")),
    )
    yield* Effect.forEach(
      interrupted,
      (message) =>
        update(
          { ...message, parts: failRunningParts(message.parts), completedAt: message.completedAt ?? now },
          message,
        ),
      { discard: true },
    )
  })

  return Messages.of({
    list: (threadId) => findByThread(threadId).pipe(Effect.mapError(persistence("messages.list"))),
    has: (id) =>
      sql`SELECT 1 FROM message WHERE id = ${id}`.pipe(
        Effect.map((rows) => rows.length > 0),
        Effect.mapError(persistence("messages.has")),
      ),
    toolOutput: (call) =>
      findToolOutput(call).pipe(
        Effect.map(Option.map((row) => row.output)),
        Effect.mapError(persistence("messages.toolOutput")),
      ),
    insert: (message) =>
      (message.completedAt === null ? insertOpen(message) : insertClosed(message)).pipe(
        Effect.mapError(persistence("messages.insert")),
      ),
    update,
    closeInterrupted,
  })
})

export const layer = Layer.effect(Messages, make)
