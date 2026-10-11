import { safeStorage } from "electron"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { SqlClient, SqlSchema } from "effect/sql"
import { type PersistenceError, persistence } from "./errors.ts"

/**
 * `encrypted` records how `value` was written, so a secret stays readable when keyring
 * availability changes between runs.
 */
const StoredSecret = Schema.fromJsonString(Schema.Struct({ encrypted: Schema.Boolean, value: Schema.String }))

const rowKey = (name: string) => `secret.${name}`

/** Named secrets (API keys) kept in the `setting` table, encrypted with Electron safeStorage when available. */
export class Secrets extends Context.Service<
  Secrets,
  {
    readonly get: (name: string) => Effect.Effect<Option.Option<string>, PersistenceError>
    readonly has: (name: string) => Effect.Effect<boolean, PersistenceError>
    readonly set: (name: string, value: string) => Effect.Effect<void, PersistenceError>
    readonly clear: (name: string) => Effect.Effect<void, PersistenceError>
  }
>()("kkcode/Secrets") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  let warnedPlaintext = false

  const findOne = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: Schema.Struct({ value: StoredSecret }),
    execute: (key) => sql`SELECT value FROM setting WHERE key = ${key}`,
  })
  const encode = Schema.encodeEffect(StoredSecret)

  const get = (name: string) =>
    findOne(rowKey(name)).pipe(
      Effect.map(
        Option.map(({ value: stored }) =>
          stored.encrypted ? safeStorage.decryptString(Buffer.from(stored.value, "base64")) : stored.value,
        ),
      ),
      Effect.mapError(persistence("secrets.get")),
    )

  const seal = (value: string) =>
    Effect.gen(function* () {
      if (safeStorage.isEncryptionAvailable()) {
        return { encrypted: true, value: safeStorage.encryptString(value).toString("base64") }
      }
      if (!warnedPlaintext) {
        warnedPlaintext = true
        yield* Effect.logWarning("safeStorage is unavailable (no OS keyring); secrets are stored as plaintext")
      }
      return { encrypted: false, value }
    })

  const set = (name: string, value: string) =>
    Effect.gen(function* () {
      const json = yield* Effect.flatMap(seal(value), encode)
      yield* sql`
        INSERT INTO setting (key, value) VALUES (${rowKey(name)}, ${json})
        ON CONFLICT (key) DO UPDATE SET value = excluded.value
      `
    }).pipe(Effect.mapError(persistence("secrets.set")))

  return Secrets.of({
    get,
    has: (name) => Effect.map(get(name), Option.isSome),
    set,
    clear: (name) =>
      sql`DELETE FROM setting WHERE key = ${rowKey(name)}`.pipe(
        Effect.asVoid,
        Effect.mapError(persistence("secrets.clear")),
      ),
  })
})

export const layer = Layer.effect(Secrets, make)
