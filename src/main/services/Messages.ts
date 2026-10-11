import { Context, Effect, Layer, Schema } from "effect"
import { SqlClient, SqlSchema } from "effect/sql"
import { TokenUsage } from "../../shared/agent.ts"
import { Message, MessagePart } from "../../shared/domain.ts"
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
  }
>()("kkcode/Messages") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const encodeRow = Schema.encodeEffect(MessageRow)

  const findByThread = SqlSchema.findAll({
    Request: Schema.String,
    Result: MessageRow,
    // A turn inserts its user and assistant messages in the same millisecond; rowid keeps them in order.
    execute: (threadId) => sql`SELECT * FROM message WHERE thread_id = ${threadId} ORDER BY created_at, rowid`,
  })

  return Messages.of({
    list: (threadId) => findByThread(threadId).pipe(Effect.mapError(persistence("messages.list"))),
    insert: (message) =>
      encodeRow(message).pipe(
        Effect.flatMap((row) => sql`INSERT INTO message ${sql.insert(row)}`),
        Effect.asVoid,
        Effect.mapError(persistence("messages.insert")),
      ),
    update: (message) =>
      encodeRow(message).pipe(
        Effect.flatMap(
          (row) => sql`
            UPDATE message SET parts = ${row.parts}, completed_at = ${row.completedAt}, usage = ${row.usage}
            WHERE id = ${row.id}
          `,
        ),
        Effect.asVoid,
        Effect.mapError(persistence("messages.update")),
      ),
  })
})

export const layer = Layer.effect(Messages, make)
