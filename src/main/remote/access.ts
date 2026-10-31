import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto"
import { hostname } from "node:os"
import { Context, Effect, Layer, Option, PubSub, Stream } from "effect"
import { SqlClient } from "effect/sql"
import type { RelayStatus, RemotePairing, RemoteStatus } from "../../shared/domain.ts"
import { clientProof, serverProof } from "../../shared/proof.ts"
import { type PersistenceError, persistence } from "../services/errors.ts"
import { Secrets } from "../services/Secrets.ts"
import { Settings } from "../services/Settings.ts"

export const REMOTE_TOKEN_SECRET = "remote.token"
const ENVIRONMENT_ID_KEY = "environment.id"

export interface EnvironmentIdentity {
  readonly id: string
  readonly name: string
}

export const CLOSE_UNAUTHORIZED = 4001
export const CLOSE_TOKEN_ROTATED = 4002
export const CLOSE_LISTENER_STOPPED = 4003
export const CLOSE_AUTH_TIMEOUT = 4004
export const CLOSE_MALFORMED_FRAME = 4005

const LOOPBACK = "127.0.0.1"

export const relayHostname = (relay: RelayStatus) => ("hostname" in relay ? relay.hostname : null)

export class RemoteAccess extends Context.Service<
  RemoteAccess,
  {
    readonly status: Effect.Effect<RemoteStatus>
    readonly pairing: Effect.Effect<RemotePairing, PersistenceError>
    readonly rotateToken: Effect.Effect<RemotePairing, PersistenceError>
    readonly authenticate: (token: string) => boolean
    readonly answerChallenge: (serverNonce: string, clientNonce: string, proof: string) => string | null
    readonly generation: () => number
    readonly rotations: Stream.Stream<void>
    readonly report: (patch: Partial<RemoteStatus>) => Effect.Effect<void>
    readonly identity: EnvironmentIdentity
  }
>()("hinacode/RemoteAccess") {}

const loadIdentity = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`INSERT INTO setting (key, value) VALUES (${ENVIRONMENT_ID_KEY}, ${randomUUID()}) ON CONFLICT (key) DO NOTHING`
  const [row] = yield* sql<{ value: string }>`SELECT value FROM setting WHERE key = ${ENVIRONMENT_ID_KEY}`
  return { id: row!.value, name: hostname() }
}).pipe(Effect.mapError(persistence("remote.identity")))

const sameSecret = (expected: string, candidate: string) => {
  const a = Buffer.from(expected)
  const b = Buffer.from(candidate)
  return a.length === b.length && timingSafeEqual(a, b)
}

const make = Effect.gen(function* () {
  const secrets = yield* Secrets
  const identity = yield* loadIdentity
  const settings = yield* Settings
  const rotated = yield* PubSub.unbounded<void>()
  let token = Option.getOrNull(yield* secrets.get(REMOTE_TOKEN_SECRET))
  let generation = 0
  let report: RemoteStatus = { listening: false, listenError: null, connected: 0, relay: { state: "off" } }

  const pairingFor = (current: string) =>
    Effect.map(settings.get, ({ remote }) => ({
      hosts: [remote.bindHost ?? LOOPBACK] as const,
      port: remote.port,
      token: current,
      relay: relayHostname(report.relay),
    }))

  const rotateToken = Effect.gen(function* () {
    const next = randomBytes(32).toString("base64url")
    yield* secrets.set(REMOTE_TOKEN_SECRET, next)
    token = next
    generation++
    yield* PubSub.publish(rotated, undefined)
    return yield* pairingFor(next)
  })

  return RemoteAccess.of({
    status: Effect.sync(() => report),
    pairing: Effect.suspend(() => (token === null ? rotateToken : pairingFor(token))),
    rotateToken,
    authenticate: (candidate) => token !== null && sameSecret(token, candidate),
    answerChallenge: (serverNonce, clientNonce, proof) =>
      token !== null && sameSecret(clientProof(token, serverNonce, clientNonce), proof)
        ? serverProof(token, clientNonce, serverNonce)
        : null,
    generation: () => generation,
    rotations: Stream.fromPubSub(rotated),
    report: (patch) => Effect.sync(() => void (report = { ...report, ...patch })),
    identity,
  })
})

export const layer = Layer.effect(RemoteAccess, make)
