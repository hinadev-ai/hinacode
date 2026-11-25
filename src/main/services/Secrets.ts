import { Context, Effect, Layer, Option, Schema } from "effect"
import { SqlClient, SqlSchema } from "effect/sql"
import type { KeyringBackend } from "../../shared/domain.ts"
import { type PersistenceError, persistence } from "./errors.ts"

const StoredSecret = Schema.fromJsonString(Schema.Struct({ encrypted: Schema.Boolean, value: Schema.String }))
type StoredSecret = typeof StoredSecret.Type

const ROW_PREFIX = "secret."

const rowKey = (name: string) => `${ROW_PREFIX}${name}`

export const threadSecretPrefix = (threadId: string) => `thread.${threadId}.`

export class Keyring extends Context.Service<
  Keyring,
  | { readonly backend: "none"; readonly open: (sealed: Buffer) => string }
  | {
      readonly backend: Exclude<KeyringBackend, "none">
      readonly seal: (value: string) => Buffer
      readonly open: (sealed: Buffer) => string
      readonly sealedByThisKey: (sealed: Buffer) => boolean
    }
>()("hinacode/Keyring") {}

export const noKeyring = Layer.succeed(
  Keyring,
  Keyring.of({
    backend: "none",
    open: () => {
      throw new Error("no keyring")
    },
  }),
)

export interface SafeStorage {
  readonly isEncryptionAvailable: () => boolean
  readonly getSelectedStorageBackend: () => string
  readonly encryptString: (value: string) => Buffer
  readonly decryptString: (sealed: Buffer) => string
}

const linuxBackends: Partial<Record<string, Exclude<KeyringBackend, "none">>> = {
  gnome_libsecret: "libsecret",
  kwallet: "kwallet",
  kwallet5: "kwallet",
  kwallet6: "kwallet",
}

const LINUX_KEYRING_PREFIX = "v11"

const safeStorageBackend = (safeStorage: SafeStorage, platform: NodeJS.Platform): KeyringBackend => {
  if (!safeStorage.isEncryptionAvailable()) return "none"
  if (platform === "darwin") return "keychain"
  if (platform === "win32") return "dpapi"
  return linuxBackends[safeStorage.getSelectedStorageBackend()] ?? "none"
}

export const safeStorageKeyring = (safeStorage: SafeStorage, platform: NodeJS.Platform) =>
  Layer.sync(Keyring, () => {
    const backend = safeStorageBackend(safeStorage, platform)
    const open = (sealed: Buffer) => safeStorage.decryptString(sealed)
    return backend === "none"
      ? Keyring.of({ backend, open })
      : Keyring.of({
          backend,
          seal: (value) => safeStorage.encryptString(value),
          open,
          sealedByThisKey: (sealed) =>
            platform !== "linux" || sealed.subarray(0, LINUX_KEYRING_PREFIX.length).toString() === LINUX_KEYRING_PREFIX,
        })
  })

export class Secrets extends Context.Service<
  Secrets,
  {
    readonly backend: KeyringBackend
    readonly get: (name: string) => Effect.Effect<Option.Option<string>, PersistenceError>
    readonly has: (name: string) => Effect.Effect<boolean, PersistenceError>
    readonly set: (name: string, value: string) => Effect.Effect<void, PersistenceError>
    readonly clear: (name: string) => Effect.Effect<void, PersistenceError>
    readonly namesUnder: (prefix: string) => Effect.Effect<ReadonlyArray<string>, PersistenceError>
    readonly clearUnder: (prefix: string) => Effect.Effect<void, PersistenceError>
  }
>()("hinacode/Secrets") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const keyring = yield* Keyring

  const findOne = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: Schema.Struct({ value: StoredSecret }),
    execute: (key) => sql`SELECT value FROM setting WHERE key = ${key}`,
  })
  const keysUnder = (prefix: string) => {
    const full = rowKey(prefix)
    return sql<{ readonly key: string; readonly value: string }>`
      SELECT key, value FROM setting WHERE substr(key, 1, ${full.length}) = ${full}
    `
  }
  const encode = Schema.encodeEffect(StoredSecret)
  const decode = Schema.decodeUnknownOption(StoredSecret)

  const openStored = (stored: StoredSecret) =>
    stored.encrypted
      ? Effect.try(() => keyring.open(Buffer.from(stored.value, "base64"))).pipe(Effect.option)
      : Effect.succeed(Option.some(stored.value))

  const sealed = (value: string): StoredSecret =>
    keyring.backend === "none"
      ? { encrypted: false, value }
      : { encrypted: true, value: keyring.seal(value).toString("base64") }

  const write = (key: string, value: string) =>
    Effect.gen(function* () {
      const json = yield* encode(sealed(value))
      yield* sql`
        INSERT INTO setting (key, value) VALUES (${key}, ${json})
        ON CONFLICT (key) DO UPDATE SET value = excluded.value
      `
    })

  const get = (name: string) =>
    findOne(rowKey(name)).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.succeed(Option.none<string>()),
          onSome: ({ value }) =>
            Effect.tap(openStored(value), (opened) =>
              Option.isNone(opened)
                ? Effect.logWarning(`secret ${name} was sealed under another key; treating it as unset`)
                : Effect.void,
            ),
        }),
      ),
      Effect.mapError(persistence("secrets.get")),
    )

  const needsRewrite = (stored: StoredSecret) =>
    keyring.backend === "none"
      ? stored.encrypted
      : !stored.encrypted || !keyring.sealedByThisKey(Buffer.from(stored.value, "base64"))

  const withSecureDelete = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const [setting] = yield* sql<Record<string, number>>`PRAGMA secure_delete`
      const previous = Object.values(setting ?? {})[0] ?? 0
      yield* sql`PRAGMA secure_delete = ON`
      const result = yield* effect.pipe(
        Effect.ensuring(Effect.ignore(sql`PRAGMA secure_delete = ${sql.literal(String(previous))}`)),
      )
      yield* sql`PRAGMA wal_checkpoint(TRUNCATE)`
      return result
    })

  const resealAll = Effect.gen(function* () {
    const stale: Array<{ readonly key: string; readonly value: string }> = []
    for (const { key, value } of yield* keysUnder("")) {
      const stored = Option.getOrUndefined(decode(value))
      if (stored === undefined || !needsRewrite(stored)) continue
      const opened = yield* openStored(stored)
      if (Option.isSome(opened)) stale.push({ key, value: opened.value })
    }
    if (stale.length === 0) return
    yield* withSecureDelete(Effect.forEach(stale, ({ key, value }) => write(key, value), { discard: true }))
    yield* Effect.logInfo(`stored ${stale.length} secrets again under keyring ${keyring.backend}`)
  }).pipe(Effect.catchCause((cause) => Effect.logWarning("resealing secrets failed", cause)))

  yield* resealAll
  if (keyring.backend === "none") yield* Effect.logWarning("no OS keyring; secrets are stored as plaintext")

  return Secrets.of({
    backend: keyring.backend,
    get,
    has: (name) => Effect.map(get(name), Option.isSome),
    set: (name, value) => write(rowKey(name), value).pipe(Effect.mapError(persistence("secrets.set"))),
    clear: (name) =>
      sql`DELETE FROM setting WHERE key = ${rowKey(name)}`.pipe(
        Effect.asVoid,
        Effect.mapError(persistence("secrets.clear")),
      ),
    namesUnder: (prefix) =>
      keysUnder(prefix).pipe(
        Effect.map((rows) => rows.map(({ key }) => key.slice(rowKey(prefix).length))),
        Effect.mapError(persistence("secrets.namesUnder")),
      ),
    clearUnder: (prefix) => {
      const full = rowKey(prefix)
      return sql`DELETE FROM setting WHERE substr(key, 1, ${full.length}) = ${full}`.pipe(
        Effect.asVoid,
        Effect.mapError(persistence("secrets.clearUnder")),
      )
    },
  })
})

export const layer = Layer.effect(Secrets, make)
