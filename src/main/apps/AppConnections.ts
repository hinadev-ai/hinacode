import { createHash, randomBytes, randomUUID } from "node:crypto"
import { Clock, Context, DateTime, Duration, Effect, FiberHandle, Layer, Option, Schema, Stream } from "effect"
import { SqlClient, SqlSchema } from "effect/sql"
import { AppConnection, type AppConnectionsStatus } from "../../shared/domain.ts"
import { relayHostname, RemoteAccess } from "../remote/access.ts"
import { Relay } from "../remote/relay.ts"
import { nowIso } from "../services/clock.ts"
import { type PersistenceError, persistence } from "../services/errors.ts"
import { Events } from "../services/Events.ts"

export const WAITING_LIFE = Duration.minutes(10)
export const AUTHORIZATION_CODE_LIFE = Duration.seconds(60)
export const MAX_REQUESTS = 5
const BEARER = "Bearer "

export interface Grant {
  readonly clientId: string
  readonly name: string
  readonly redirectUri: string
  readonly codeChallenge: string
}

export interface ConnectRequest extends Grant {
  readonly state: string | undefined
}

export type Outcome =
  | { readonly type: "waiting"; readonly request: ConnectRequest }
  | { readonly type: "approved"; readonly request: ConnectRequest; readonly authorizationCode: string }
  | { readonly type: "denied"; readonly request: ConnectRequest }
  | { readonly type: "unknown" }

type Answer =
  | { readonly type: "waiting" }
  | { readonly type: "approved"; readonly authorizationCode: string }
  | { readonly type: "denied" }

export class AppConnections extends Context.Service<
  AppConnections,
  {
    readonly status: Effect.Effect<AppConnectionsStatus, PersistenceError>
    readonly start: Effect.Effect<AppConnectionsStatus, PersistenceError>
    readonly answer: (input: {
      readonly id: string
      readonly approve: boolean
    }) => Effect.Effect<AppConnectionsStatus, PersistenceError>
    readonly remove: (id: string) => Effect.Effect<AppConnectionsStatus, PersistenceError>
    readonly announce: Effect.Effect<void>
    readonly issuer: Effect.Effect<Option.Option<string>>
    readonly inUse: Effect.Effect<boolean, PersistenceError>
    readonly request: (request: ConnectRequest) => Effect.Effect<Option.Option<string>>
    readonly outcome: (id: string) => Effect.Effect<Outcome>
    readonly redeem: (authorizationCode: string) => Effect.Effect<Option.Option<Grant>>
    readonly connect: (name: string) => Effect.Effect<{ readonly id: string; readonly token: string }, PersistenceError>
    readonly authenticate: (authorization: string | undefined) => Effect.Effect<Option.Option<string>, PersistenceError>
    readonly listening: (port: number) => Effect.Effect<void>
    readonly port: () => number | null
  }
>()("hinacode/AppConnections") {}

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex")

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const access = yield* RemoteAccess
  const events = yield* Events
  const expiry = yield* FiberHandle.make<void>()

  let waitingUntil: number | null = null
  const requests = new Map<string, { readonly request: ConnectRequest; readonly expiresAt: number; answer: Answer }>()
  const grants = new Map<string, { readonly grant: Grant; readonly expiresAt: number }>()
  let port: number | null = null

  const findAll = SqlSchema.findAll({
    Request: Schema.Void,
    Result: AppConnection,
    execute: () => sql`SELECT id, name, created_at, last_used_at FROM app_connection ORDER BY created_at, rowid`,
  })
  const countAll = SqlSchema.findOne({
    Request: Schema.Void,
    Result: Schema.Struct({ connections: Schema.Number }),
    execute: () => sql`SELECT COUNT(*) AS connections FROM app_connection`,
  })
  const touch = SqlSchema.findOneOption({
    Request: Schema.Struct({ tokenHash: Schema.String, usedAt: Schema.String }),
    Result: Schema.Struct({ id: Schema.String }),
    execute: ({ tokenHash, usedAt }) =>
      sql`UPDATE app_connection SET last_used_at = ${usedAt} WHERE token_hash = ${tokenHash} RETURNING id`,
  })

  const forgetExpired = Effect.map(Clock.currentTimeMillis, (now) => {
    if (waitingUntil !== null && waitingUntil <= now) waitingUntil = null
    for (const [id, pending] of requests) if (pending.expiresAt <= now) requests.delete(id)
    for (const [key, pending] of grants) if (pending.expiresAt <= now) grants.delete(key)
    return now
  })

  const issuer = Effect.map(access.status, ({ relay }) =>
    Option.map(Option.fromNullishOr(relayHostname(relay)), (hostname) => `https://${hostname}`),
  )

  const status = Effect.gen(function* () {
    yield* forgetExpired
    const connections = yield* findAll(undefined).pipe(Effect.mapError(persistence("appConnections.list")))
    return {
      url: Option.getOrNull(Option.map(yield* issuer, (origin) => `${origin}/mcp`)),
      waitingUntil: waitingUntil === null ? null : DateTime.formatIso(DateTime.makeUnsafe(waitingUntil)),
      requests: [...requests]
        .filter(([, pending]) => pending.answer.type === "waiting")
        .map(([id, { request }]) => ({ id, name: request.name, redirectHost: new URL(request.redirectUri).host })),
      connections,
    }
  })

  const announce = status.pipe(
    Effect.flatMap((current) => events.publish({ type: "appConnections.changed", status: current })),
    Effect.catch((error) => Effect.logWarning("could not announce app connections", error.message)),
  )

  const start = Effect.gen(function* () {
    waitingUntil = (yield* Clock.currentTimeMillis) + Duration.toMillis(WAITING_LIFE)
    yield* FiberHandle.run(expiry, Effect.andThen(Effect.sleep(WAITING_LIFE), announce))
    yield* announce
    return yield* status
  })

  const waitingCount = () => [...requests.values()].filter(({ answer }) => answer.type === "waiting").length

  const request = (incoming: ConnectRequest) =>
    Effect.gen(function* () {
      yield* forgetExpired
      if (waitingUntil === null || waitingCount() >= MAX_REQUESTS) return Option.none<string>()
      const id = randomBytes(24).toString("base64url")
      requests.set(id, { request: incoming, expiresAt: waitingUntil, answer: { type: "waiting" } })
      yield* announce
      return Option.some(id)
    })

  const answer = ({ id, approve }: { readonly id: string; readonly approve: boolean }) =>
    Effect.gen(function* () {
      const now = yield* forgetExpired
      const pending = requests.get(id)
      if (pending === undefined || pending.answer.type !== "waiting") return yield* status
      if (!approve) {
        pending.answer = { type: "denied" }
        return yield* Effect.andThen(announce, status)
      }
      const authorizationCode = randomBytes(32).toString("base64url")
      const { state: _, ...grant } = pending.request
      grants.set(sha256(authorizationCode), {
        grant,
        expiresAt: now + Duration.toMillis(AUTHORIZATION_CODE_LIFE),
      })
      for (const other of requests.values()) if (other.answer.type === "waiting") other.answer = { type: "denied" }
      requests.set(id, {
        request: pending.request,
        expiresAt: now + Duration.toMillis(AUTHORIZATION_CODE_LIFE),
        answer: { type: "approved", authorizationCode },
      })
      waitingUntil = null
      yield* FiberHandle.clear(expiry)
      return yield* Effect.andThen(announce, status)
    })

  const outcome = (id: string) =>
    Effect.map(forgetExpired, (): Outcome => {
      const pending = requests.get(id)
      if (pending === undefined) return { type: "unknown" }
      if (pending.answer.type === "waiting") return { type: "waiting", request: pending.request }
      requests.delete(id)
      return pending.answer.type === "approved"
        ? { type: "approved", request: pending.request, authorizationCode: pending.answer.authorizationCode }
        : { type: "denied", request: pending.request }
    })

  const redeem = (authorizationCode: string) =>
    Effect.map(forgetExpired, () => {
      const key = sha256(authorizationCode)
      const pending = grants.get(key)
      grants.delete(key)
      return Option.map(Option.fromNullishOr(pending), ({ grant }) => grant)
    })

  const connect = (name: string) =>
    Effect.gen(function* () {
      const id = randomUUID()
      const token = randomBytes(32).toString("base64url")
      const createdAt = yield* nowIso
      yield* sql`INSERT INTO app_connection ${sql.insert({ id, name, tokenHash: sha256(token), createdAt })}`.pipe(
        Effect.mapError(persistence("appConnections.connect")),
      )
      yield* announce
      return { id, token }
    })

  const authenticate = (authorization: string | undefined) =>
    Effect.gen(function* () {
      if (authorization === undefined || !authorization.startsWith(BEARER)) return Option.none<string>()
      const found = yield* touch({ tokenHash: sha256(authorization.slice(BEARER.length)), usedAt: yield* nowIso }).pipe(
        Effect.mapError(persistence("appConnections.authenticate")),
      )
      if (Option.isSome(found)) yield* announce
      return Option.map(found, ({ id }) => id)
    })

  return AppConnections.of({
    status,
    start,
    answer,
    remove: (id) =>
      sql`DELETE FROM app_connection WHERE id = ${id}`.pipe(
        Effect.mapError(persistence("appConnections.remove")),
        Effect.andThen(announce),
        Effect.andThen(status),
      ),
    announce,
    issuer,
    inUse: Effect.gen(function* () {
      yield* forgetExpired
      if (waitingUntil !== null || requests.size > 0 || grants.size > 0) return true
      const { connections } = yield* countAll(undefined).pipe(Effect.mapError(persistence("appConnections.count")))
      return connections > 0
    }),
    request,
    outcome,
    redeem,
    connect,
    authenticate,
    listening: (listeningOn) => Effect.sync(() => void (port = listeningOn)),
    port: () => port,
  })
})

export const layer = Layer.effect(AppConnections, make)

export const followRelayLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const relay = yield* Relay
    const connections = yield* AppConnections
    yield* relay.changes.pipe(
      Stream.map(relayHostname),
      Stream.changes,
      Stream.drop(1),
      Stream.runForEach(() => connections.announce),
      Effect.forkScoped,
    )
  }),
)
