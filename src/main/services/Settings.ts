import { Context, Effect, Layer, PubSub, Schema, Stream } from "effect"
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
    /** Every value `set` writes, from subscription time on. */
    readonly changes: Stream.Stream<SettingsValue>
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
    const stored = Object.fromEntries(rows.map((row) => [row.key, row.value]))
    return yield* decodeSettings({ ...defaultSettings, ...stored })
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

  return Settings.of({ get, set, changes: Stream.fromPubSub(written) })
})

export const layer = Layer.effect(Settings, make)
