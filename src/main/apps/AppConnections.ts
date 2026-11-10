import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto"
import { Clock, Context, DateTime, Duration, Effect, FiberHandle, Layer, Option, Schema, Stream } from "effect"
import { SqlClient, SqlSchema } from "effect/sql"
import { AppConnection, type AppConnectionsStatus } from "../../shared/domain.ts"
import { relayHostname, RemoteAccess } from "../remote/access.ts"
import { Relay } from "../remote/relay.ts"
import { nowIso } from "../services/clock.ts"
import { type PersistenceError, persistence } from "../services/errors.ts"
import { Events } from "../services/Events.ts"

const APPROVAL_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
const APPROVAL_CODE_LENGTH = 8
export const APPROVAL_CODE_LIFE = Duration.minutes(10)
export const APPROVAL_TRIES = 5
export const AUTHORIZATION_CODE_LIFE = Duration.seconds(60)
const BEARER = "Bearer "

export interface Grant {
  readonly clientId: string
  readonly name: string
  readonly redirectUri: string
  readonly codeChallenge: string
}

export type Approval =
  | { readonly approved: true; readonly authorizationCode: string }
  | { readonly approved: false; readonly codeLive: boolean }

export class AppConnections extends Context.Service<
  AppConnections,
  {
    readonly status: Effect.Effect<AppConnectionsStatus, PersistenceError>
    readonly newApprovalCode: Effect.Effect<AppConnectionsStatus, PersistenceError>
    readonly remove: (id: string) => Effect.Effect<AppConnectionsStatus, PersistenceError>
    readonly announce: Effect.Effect<void>
    readonly issuer: Effect.Effect<Option.Option<string>>
    readonly inUse: Effect.Effect<boolean, PersistenceError>
    readonly approve: (approvalCode: string, grant: Grant) => Effect.Effect<Approval>
    readonly redeem: (authorizationCode: string) => Effect.Effect<Option.Option<Grant>>
    readonly connect: (name: string) => Effect.Effect<{ readonly id: string; readonly token: string }, PersistenceError>
    readonly authenticate: (authorization: string | undefined) => Effect.Effect<Option.Option<string>, PersistenceError>
    readonly listening: (port: number) => Effect.Effect<void>
    readonly port: () => number | null
  }
>()("hinacode/AppConnections") {}

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex")

const sameText = (expected: string, candidate: string) => {
  const a = Buffer.from(expected)
  const b = Buffer.from(candidate)
  return a.length === b.length && timingSafeEqual(a, b)
}

const newApprovalText = () =>
  Array.from(randomBytes(APPROVAL_CODE_LENGTH), (byte) => APPROVAL_ALPHABET[byte % APPROVAL_ALPHABET.length]).join("")

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const access = yield* RemoteAccess
  const events = yield* Events
  const expiry = yield* FiberHandle.make<void>()

  let approval: { readonly code: string; readonly expiresAt: number; triesLeft: number } | null = null
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
    if (approval !== null && approval.expiresAt <= now) approval = null
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
      approvalCode:
        approval === null
          ? null
          : { code: approval.code, expiresAt: DateTime.formatIso(DateTime.makeUnsafe(approval.expiresAt)) },
      connections,
    }
  })

  const announce = status.pipe(
    Effect.flatMap((current) => events.publish({ type: "appConnections.changed", status: current })),
    Effect.catch((error) => Effect.logWarning("could not announce app connections", error.message)),
  )

  const newApprovalCode = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis
    approval = {
      code: newApprovalText(),
      expiresAt: now + Duration.toMillis(APPROVAL_CODE_LIFE),
      triesLeft: APPROVAL_TRIES,
    }
    yield* FiberHandle.run(expiry, Effect.andThen(Effect.sleep(APPROVAL_CODE_LIFE), announce))
    yield* announce
    return yield* status
  })

  const approve = (candidate: string, grant: Grant) =>
    Effect.gen(function* () {
      const now = yield* forgetExpired
      if (approval === null) return { approved: false, codeLive: false } as const
      if (!sameText(approval.code, candidate.trim().toUpperCase())) {
        approval.triesLeft -= 1
        if (approval.triesLeft > 0) return { approved: false, codeLive: true } as const
        approval = null
        yield* FiberHandle.clear(expiry)
        yield* announce
        return { approved: false, codeLive: false } as const
      }
      approval = null
      const authorizationCode = randomBytes(32).toString("base64url")
      grants.set(sha256(authorizationCode), { grant, expiresAt: now + Duration.toMillis(AUTHORIZATION_CODE_LIFE) })
      yield* FiberHandle.clear(expiry)
      yield* announce
      return { approved: true, authorizationCode } as const
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
      return Option.map(found, ({ id }) => id)
    })

  return AppConnections.of({
    status,
    newApprovalCode,
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
      if (approval !== null || grants.size > 0) return true
      const { connections } = yield* countAll(undefined).pipe(Effect.mapError(persistence("appConnections.count")))
      return connections > 0
    }),
    approve,
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
