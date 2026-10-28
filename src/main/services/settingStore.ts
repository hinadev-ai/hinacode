import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { Effect, Predicate, PubSub, Schema, type Scope, Semaphore, Stream } from "effect"
import { type PersistenceError, persistence } from "./errors.ts"

export interface SettingStore<A> {
  readonly get: Effect.Effect<A, PersistenceError>
  readonly set: (patch: Partial<A>) => Effect.Effect<A, PersistenceError>
  /**
   * Every value `set` writes after this effect ran. The subscription exists once it returns, so a `set`
   * between it and running the stream is not lost, as it would be with a stream subscribed on first pull.
   */
  readonly changes: Effect.Effect<Stream.Stream<A>, never, Scope.Scope>
}

export interface SettingFiles<A> {
  /** A JSON object holding the keys that were set, except the `own` ones. */
  readonly path: string
  /** Keys kept in a file of their own, whose whole content is the key's value. */
  readonly own?: { readonly [K in keyof A]?: string }
}

// Sync like the SQLite client the settings used to live in: a turn reads them on its way to the agent, and a read that
// yields would let callers see the turn start later than before.
const readJson = (path: string) =>
  Effect.try({
    try: () => {
      if (!existsSync(path)) return undefined
      return JSON.parse(readFileSync(path, "utf8")) as unknown
    },
    catch: persistence(`read ${path}`),
  })

const writeJson = (path: string, value: unknown) =>
  Effect.try({
    try: () => {
      mkdirSync(dirname(path), { recursive: true })
      const temp = `${path}.${randomUUID()}.tmp`
      writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`)
      renameSync(temp, path)
    },
    catch: persistence(`write ${path}`),
  })

const readObject = (path: string) =>
  Effect.flatMap(readJson(path), (value) =>
    value === undefined || Predicate.isObject(value)
      ? Effect.succeed((value ?? {}) as Record<string, unknown>)
      : Effect.fail(persistence(`read ${path}`)(new Error("Expected a JSON object"))),
  )

/**
 * Settings kept as JSON files that hold only the keys that were set, so a later change to a default still applies.
 * Every `get` reads the files, so a hand edit shows up on the next read.
 */
export const makeSettingStore = <A extends Record<string, unknown>>(
  schema: Schema.Codec<A, unknown>,
  defaults: A,
  { path, own = {} }: SettingFiles<A>,
) =>
  Effect.gen(function* () {
    const written = yield* PubSub.unbounded<A>()
    // Two overlapping sets would each read the file and the later rename would drop the other's keys.
    const writes = yield* Semaphore.make(1)
    const ownFiles = Object.entries(own).filter((entry): entry is [string, string] => entry[1] !== undefined)
    const ownKeys = new Set(ownFiles.map(([key]) => key))
    const files = [path, ...ownFiles.map(([, file]) => file)].join(" and ")
    const decode = Schema.decodeUnknownEffect(schema)

    const get = Effect.gen(function* () {
      const stored = yield* readObject(path)
      for (const [key, file] of ownFiles) {
        const value = yield* readJson(file)
        if (value !== undefined) stored[key] = value
      }
      // A file written before a key existed lacks it, so a stored object is laid over its default instead of replacing it.
      const merged = Object.fromEntries(
        Object.entries(defaults).map(([key, fallback]) => {
          const value = stored[key]
          return [
            key,
            Predicate.isObject(fallback) && Predicate.isObject(value) ? { ...fallback, ...value } : (value ?? fallback),
          ]
        }),
      )
      return yield* decode(merged).pipe(Effect.mapError(persistence(`decode ${files}`)))
    })

    const set = (patch: Partial<A>) =>
      Effect.gen(function* () {
        const entries = Object.entries(patch).filter(([, value]) => value !== undefined)
        const shared = entries.filter(([key]) => !ownKeys.has(key))
        if (shared.length > 0) {
          const stored = yield* readObject(path)
          yield* writeJson(path, { ...stored, ...Object.fromEntries(shared) })
        }
        for (const [key, file] of ownFiles) {
          if (key in patch && patch[key] !== undefined) yield* writeJson(file, patch[key])
        }
        const next = yield* get
        yield* PubSub.publish(written, next)
        return next
      }).pipe(writes.withPermit)

    const store: SettingStore<A> = { get, set, changes: Effect.map(PubSub.subscribe(written), Stream.fromSubscription) }
    return store
  })
