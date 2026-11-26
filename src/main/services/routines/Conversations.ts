import { Context, Effect, Layer, Option, Schema } from "effect"
import { SqlClient, SqlSchema } from "effect/sql"
import { ReplyDestination } from "../../../shared/domain.ts"
import { type PersistenceError, persistence } from "../errors.ts"

export interface Conversation {
  readonly routineId: string
  readonly key: string
  readonly threadId: string
  readonly destination: ReplyDestination
}

export class Conversations extends Context.Service<
  Conversations,
  {
    readonly find: (
      routineId: string,
      key: string,
    ) => Effect.Effect<Option.Option<Pick<Conversation, "threadId" | "destination">>, PersistenceError>
    readonly put: (conversation: Conversation) => Effect.Effect<void, PersistenceError>
    readonly ofThread: (threadId: string) => Effect.Effect<Option.Option<ReplyDestination>, PersistenceError>
    readonly forget: (threadId: string) => Effect.Effect<void, PersistenceError>
  }
>()("hinacode/Conversations") {}

const ConversationRow = Schema.Struct({
  routineId: Schema.String,
  key: Schema.String,
  threadId: Schema.String,
  destination: Schema.fromJsonString(ReplyDestination),
})

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  const findByKey = SqlSchema.findOneOption({
    Request: Schema.Struct({ routineId: Schema.String, key: Schema.String }),
    Result: ConversationRow,
    execute: ({ routineId, key }) =>
      sql`SELECT * FROM routine_conversation WHERE routine_id = ${routineId} AND key = ${key}`,
  })
  const findByThread = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: ConversationRow,
    execute: (threadId) => sql`SELECT * FROM routine_conversation WHERE thread_id = ${threadId}`,
  })
  const encodeRow = Schema.encodeEffect(ConversationRow)
  const upsert = (conversation: Conversation) =>
    Effect.flatMap(
      encodeRow(conversation),
      (row) => sql`
        INSERT INTO routine_conversation ${sql.insert(row)}
        ON CONFLICT (routine_id, key) DO UPDATE SET thread_id = excluded.thread_id, destination = excluded.destination
      `,
    )

  return Conversations.of({
    find: (routineId, key) =>
      findByKey({ routineId, key }).pipe(
        Effect.map(Option.map(({ threadId, destination }) => ({ threadId, destination }))),
        Effect.mapError(persistence("conversations.find")),
      ),
    put: (conversation) => upsert(conversation).pipe(Effect.asVoid, Effect.mapError(persistence("conversations.put"))),
    ofThread: (threadId) =>
      findByThread(threadId).pipe(
        Effect.map(Option.map(({ destination }) => destination)),
        Effect.mapError(persistence("conversations.ofThread")),
      ),
    forget: (threadId) =>
      sql`DELETE FROM routine_conversation WHERE thread_id = ${threadId}`.pipe(
        Effect.asVoid,
        Effect.mapError(persistence("conversations.forget")),
      ),
  })
})

export const layer = Layer.effect(Conversations, make)
