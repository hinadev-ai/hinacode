import { Context, Effect, Layer, Predicate, PubSub, Schema, type Scope, Stream } from "effect"
import { SqlClient, SqlSchema } from "effect/sql"
import { defaultSettings, Settings as SettingsSchema } from "../../shared/domain.ts"
import { type PersistenceError, persistence } from "./errors.ts"

type SettingsValue = typeof SettingsSchema.Type
const settingKeys = Object.keys(SettingsSchema.fields)

const JsonValue = Schema.fromJsonString(Schema.Unknown)
const SettingRow = Schema.Struct({ key: Schema.String, value: JsonValue })

export class Settings extends Context.Service<
  Settings,
  {
    readonly get: Effect.Effect<SettingsValue, PersistenceError>
    readonly set: (patch: Partial<SettingsValue>) => Effect.Effect<SettingsValue, PersistenceError>
    /**
     * Every value `set` writes after this effect ran. The subscription exists once it returns, so a `set`
     * between it and running the stream is not lost, as it would be with a stream subscribed on first pull.
     */
    readonly changes: Effect.Effect<Stream.Stream<SettingsValue>, never, Scope.Scope>
  }
>()("kkcode/Settings") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const written = yield* PubSub.unbounded<SettingsValue>()

  const findAll = SqlSchema.findAll({
    Request: Schema.Void,
    Result: SettingRow,
    // Other rows (secrets) share the table and are not necessarily JSON.
    execute: () => sql`SELECT key, value FROM setting WHERE ${sql.in("key", settingKeys)}`,
  })
  const decodeSettings = Schema.decodeUnknownEffect(SettingsSchema)
  const encodeValue = Schema.encodeEffect(JsonValue)

  const get = Effect.gen(function* () {
    const rows = yield* findAll(undefined)
    const stored = new Map(rows.map((row) => [row.key, row.value]))
    // A row saved before a key existed lacks it, so a stored object is laid over its default instead of replacing it.
    const merged = Object.fromEntries(
      Object.entries(defaultSettings).map(([key, fallback]) => {
        const value = stored.get(key)
        return [
          key,
          Predicate.isObject(fallback) && Predicate.isObject(value) ? { ...fallback, ...value } : (value ?? fallback),
        ]
      }),
    )
    return yield* decodeSettings(merged)
  }).pipe(Effect.mapError(persistence("settings.get")))

  const set = (patch: Partial<SettingsValue>) =>
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
      ).pipe(sql.withTransaction, Effect.mapError(persistence("settings.set")))
      const next = yield* get
      yield* PubSub.publish(written, next)
      return next
    })

  return Settings.of({ get, set, changes: Effect.map(PubSub.subscribe(written), Stream.fromSubscription) })
})

export const layer = Layer.effect(Settings, make)
