import { safeStorage } from "electron"
import { Context, Effect, Layer } from "effect"
import { SqlClient } from "effect/sql"
import { type PersistenceError, persistence } from "./errors.ts"

/**
 * Secrets live in the `setting` table under `secret.<name>`, encrypted with Electron safeStorage
 * and stored as base64. Values never cross the rpc boundary.
 */
export class Secrets extends Context.Service<
  Secrets,
  {
    readonly has: (name: string) => Effect.Effect<boolean, PersistenceError>
    readonly get: (name: string) => Effect.Effect<string | null, PersistenceError>
    readonly set: (name: string, value: string) => Effect.Effect<void, PersistenceError>
    readonly clear: (name: string) => Effect.Effect<void, PersistenceError>
  }
>()("kkcode/Secrets") {}

const key = (name: string) => `secret.${name}`

const PLAINTEXT_PREFIX = "plain:"

const encrypt = (value: string) => {
  if (safeStorage.isEncryptionAvailable()) return safeStorage.encryptString(value).toString("base64")
  // Linux without a keyring has no encryption backend; storing beats losing the key.
  console.warn("[secrets] safeStorage encryption is unavailable, storing the secret as plaintext")
  return PLAINTEXT_PREFIX + Buffer.from(value).toString("base64")
}

const decrypt = (stored: string) =>
  stored.startsWith(PLAINTEXT_PREFIX)
    ? Buffer.from(stored.slice(PLAINTEXT_PREFIX.length), "base64").toString()
    : safeStorage.decryptString(Buffer.from(stored, "base64"))

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  const read = (name: string) =>
    sql<{ value: string }>`SELECT value FROM setting WHERE key = ${key(name)}`.pipe(
      Effect.map((rows) => rows[0]?.value ?? null),
      Effect.mapError(persistence("secrets.read")),
    )

  return Secrets.of({
    has: (name) => read(name).pipe(Effect.map((value) => value !== null)),
    get: (name) =>
      read(name).pipe(
        Effect.flatMap((value) => (value === null ? Effect.succeed(null) : Effect.try(() => decrypt(value)))),
        Effect.mapError(persistence("secrets.get")),
      ),
    set: (name, value) =>
      Effect.suspend(
        () => sql`
          INSERT INTO setting (key, value) VALUES (${key(name)}, ${encrypt(value)})
          ON CONFLICT (key) DO UPDATE SET value = excluded.value
        `,
      ).pipe(Effect.asVoid, Effect.mapError(persistence("secrets.set"))),
    clear: (name) =>
      sql`DELETE FROM setting WHERE key = ${key(name)}`.pipe(
        Effect.asVoid,
        Effect.mapError(persistence("secrets.clear")),
      ),
  })
})

export const layer = Layer.effect(Secrets, make)
