import { Context, Effect, Layer, Schema } from "effect"
import { SqlClient, SqlSchema } from "effect/sql"
import { TokenUsage } from "../../shared/agent.ts"
import { Message, MessagePart } from "../../shared/domain.ts"
import { failRunningTools } from "../../shared/foldEvent.ts"
import { nowIso } from "./clock.ts"
import { type PersistenceError, persistence } from "./errors.ts"

/** `parts` and `usage` are JSON text columns. */
const MessageRow = Schema.Struct({
  ...Message.fields,
  parts: Schema.fromJsonString(Schema.Array(MessagePart)),
  usage: Schema.NullOr(Schema.fromJsonString(TokenUsage)),
})

export class Messages extends Context.Service<
  Messages,
  {
    readonly list: (threadId: string) => Effect.Effect<ReadonlyArray<Message>, PersistenceError>
    readonly insert: (message: Message) => Effect.Effect<void, PersistenceError>
    /** Writes the fields that change while a turn streams: parts, completedAt and usage. */
    readonly update: (message: Message) => Effect.Effect<void, PersistenceError>
    /**
     * Completes assistant messages a killed app left streaming and fails their running tool calls.
     * Only safe at boot, before any turn runs.
     */
    readonly closeInterrupted: Effect.Effect<void, PersistenceError>
  }
>()("hinacode/Messages") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const encodeRow = Schema.encodeEffect(MessageRow)

  const findByThread = SqlSchema.findAll({
    Request: Schema.String,
    Result: MessageRow,
    // A turn inserts its user and assistant messages in the same millisecond; rowid keeps them in order.
    execute: (threadId) => sql`SELECT * FROM message WHERE thread_id = ${threadId} ORDER BY created_at, rowid`,
  })

  const findInterrupted = SqlSchema.findAll({
    Request: Schema.Void,
    Result: MessageRow,
    execute: () => sql`
      SELECT * FROM message
      WHERE role = 'assistant' AND (
        completed_at IS NULL OR EXISTS (
          SELECT 1 FROM json_each(message.parts)
          WHERE json_extract(value, '$.type') = 'tool_call' AND json_extract(value, '$.status') = 'running'
        )
      )
    `,
  })

  const update = (message: Message) =>
    encodeRow(message).pipe(
      Effect.flatMap(
        (row) => sql`
          UPDATE message SET parts = ${row.parts}, completed_at = ${row.completedAt}, usage = ${row.usage}
          WHERE id = ${row.id}
        `,
      ),
      Effect.asVoid,
      Effect.mapError(persistence("messages.update")),
    )

  const closeInterrupted = Effect.gen(function* () {
    const now = yield* nowIso
    const interrupted = yield* findInterrupted(undefined).pipe(
      Effect.mapError(persistence("messages.closeInterrupted")),
    )
    yield* Effect.forEach(
      interrupted,
      (message) =>
        update({ ...message, parts: failRunningTools(message.parts), completedAt: message.completedAt ?? now }),
      { discard: true },
    )
  })

  return Messages.of({
    list: (threadId) => findByThread(threadId).pipe(Effect.mapError(persistence("messages.list"))),
    insert: (message) =>
      encodeRow(message).pipe(
        Effect.flatMap((row) => sql`INSERT INTO message ${sql.insert(row)}`),
        Effect.asVoid,
        Effect.mapError(persistence("messages.insert")),
      ),
    update,
    closeInterrupted,
  })
})

export const layer = Layer.effect(Messages, make)
