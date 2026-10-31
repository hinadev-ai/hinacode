import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { Effect, Exit, Predicate, PubSub, Schema, type Scope, Semaphore, Stream } from "effect"
import { type PersistenceError, persistence } from "./errors.ts"

export interface SettingStore<A> {
  readonly get: Effect.Effect<A, PersistenceError>
  readonly set: (patch: Partial<A>) => Effect.Effect<A, PersistenceError>
  readonly changes: Effect.Effect<Stream.Stream<A>, never, Scope.Scope>
}

export interface SettingFiles<A> {
  readonly path: string
  readonly own?: { readonly [K in keyof A]?: string }
}

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

const broken = (error: PersistenceError) => Effect.logWarning(`${error.message}, using defaults`, error.cause)

export const makeSettingStore = <A extends Record<string, unknown>>(
  schema: Schema.Codec<A, unknown> & { readonly fields: { readonly [key: string]: Schema.Codec<unknown, unknown> } },
  defaults: A,
  { path, own = {} }: SettingFiles<A>,
) =>
  Effect.gen(function* () {
    const written = yield* PubSub.unbounded<A>()
    const writes = yield* Semaphore.make(1)
    const ownFiles = Object.entries(own).filter((entry): entry is [string, string] => entry[1] !== undefined)
    const ownKeys = new Set(ownFiles.map(([key]) => key))
    const files = [path, ...ownFiles.map(([, file]) => file)].join(" and ")
    const decode = Schema.decodeUnknownEffect(schema)

    const decodes = (key: string, value: unknown) =>
      Effect.map(Effect.exit(Schema.decodeUnknownEffect(schema.fields[key]!)(value)), Exit.isSuccess)

    const get = Effect.gen(function* () {
      const stored = yield* readObject(path).pipe(
        Effect.catch((error) => Effect.as(broken(error), {} as Record<string, unknown>)),
      )
      for (const [key, file] of ownFiles) {
        const value = yield* readJson(file).pipe(Effect.catch((error) => Effect.as(broken(error), undefined)))
        if (value !== undefined) stored[key] = value
      }
      const merged = yield* Effect.forEach(Object.entries(defaults), ([key, fallback]) =>
        Effect.gen(function* () {
          const value = stored[key]
          if (value === undefined) return [key, fallback] as const
          const laid = Predicate.isObject(fallback) && Predicate.isObject(value) ? { ...fallback, ...value } : value
          if (yield* decodes(key, laid)) return [key, laid] as const
          yield* Effect.logWarning(`${files}: ${key} is not a valid value, using its default`)
          return [key, fallback] as const
        }),
      ).pipe(Effect.map(Object.fromEntries))
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
          if (patch[key] === undefined) continue
          yield* readJson(file)
          yield* writeJson(file, patch[key])
        }
        const next = yield* get
        yield* PubSub.publish(written, next)
        return next
      }).pipe(writes.withPermit)

    const store: SettingStore<A> = { get, set, changes: Effect.map(PubSub.subscribe(written), Stream.fromSubscription) }
    return store
  })
