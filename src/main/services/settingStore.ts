import { Effect, Predicate, PubSub, Schema, type Scope, Stream } from "effect"
import { SqlClient, SqlSchema } from "effect/sql"
import { type PersistenceError, persistence } from "./errors.ts"

const JsonValue = Schema.fromJsonString(Schema.Unknown)
const SettingRow = Schema.Struct({ key: Schema.String, value: JsonValue })

export interface SettingStore<A> {
  readonly get: Effect.Effect<A, PersistenceError>
  readonly set: (patch: Partial<A>) => Effect.Effect<A, PersistenceError>
  /**
   * Every value `set` writes after this effect ran. The subscription exists once it returns, so a `set`
   * between it and running the stream is not lost, as it would be with a stream subscribed on first pull.
   */
  readonly changes: Effect.Effect<Stream.Stream<A>, never, Scope.Scope>
}

/** One JSON row per top-level key in the `setting` table. `name` labels persistence errors. */
export const makeSettingStore = <A extends Record<string, unknown>>(
  schema: Schema.Codec<A, unknown> & { readonly fields: Record<string, unknown> },
  defaults: A,
  name: string,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const written = yield* PubSub.unbounded<A>()
    const keys = Object.keys(schema.fields)

    const findAll = SqlSchema.findAll({
      Request: Schema.Void,
      Result: SettingRow,
      // Other rows (secrets) share the table and are not necessarily JSON.
      execute: () => sql`SELECT key, value FROM setting WHERE ${sql.in("key", keys)}`,
    })
    const decode = Schema.decodeUnknownEffect(schema)
    const encodeValue = Schema.encodeEffect(JsonValue)

    const get = Effect.gen(function* () {
      const rows = yield* findAll(undefined)
      const stored = new Map(rows.map((row) => [row.key, row.value]))
      // A row saved before a key existed lacks it, so a stored object is laid over its default instead of replacing it.
      const merged = Object.fromEntries(
        Object.entries(defaults).map(([key, fallback]) => {
          const value = stored.get(key)
          return [
            key,
            Predicate.isObject(fallback) && Predicate.isObject(value) ? { ...fallback, ...value } : (value ?? fallback),
          ]
        }),
      )
      return yield* decode(merged)
    }).pipe(Effect.mapError(persistence(`${name}.get`)))

    const set = (patch: Partial<A>) =>
      Effect.gen(function* () {
        const entries = Object.entries(patch).filter(([, value]) => value !== undefined)
        yield* Effect.forEach(entries, ([key, value]) =>
          Effect.flatMap(
            encodeValue(value),
            (json) => sql`
              INSERT INTO setting (key, value) VALUES (${key}, ${json})
              ON CONFLICT (key) DO UPDATE SET value = excluded.value
            `,
          ),
        ).pipe(sql.withTransaction, Effect.mapError(persistence(`${name}.set`)))
        const next = yield* get
        yield* PubSub.publish(written, next)
        return next
      })

    const store: SettingStore<A> = { get, set, changes: Effect.map(PubSub.subscribe(written), Stream.fromSubscription) }
    return store
  })
