import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto"
import { hostname, networkInterfaces } from "node:os"
import { Context, Effect, Layer, Option, PubSub, Stream } from "effect"
import { SqlClient } from "effect/sql"
import type { RemotePairing, RemoteStatus } from "../../shared/domain.ts"
import { type PersistenceError, persistence } from "../services/errors.ts"
import { Secrets } from "../services/Secrets.ts"
import { Settings } from "../services/Settings.ts"

export const REMOTE_TOKEN_SECRET = "remote.token"
const ENVIRONMENT_ID_KEY = "environment.id"

/** Who this kkcode is to a desktop that pairs with it. The id is made once per data directory. */
export interface EnvironmentIdentity {
  readonly id: string
  readonly name: string
}

/** Close codes a client can tell apart from a network drop. */
export const CLOSE_UNAUTHORIZED = 4001
export const CLOSE_TOKEN_ROTATED = 4002
export const CLOSE_LISTENER_STOPPED = 4003

const isTailscale = (address: string) => address.startsWith("100.")

/**
 * Addresses a phone could reach this machine on, Tailscale first, then LAN, then the hostname.
 * Nothing on loopback, since a phone is never on it.
 */
export const reachableHosts = (bindHost: string): ReadonlyArray<string> => {
  if (bindHost !== "0.0.0.0" && bindHost !== "::") return [bindHost]
  const addresses = Object.values(networkInterfaces())
    .flatMap((nets) => nets ?? [])
    .filter((net) => net.family === "IPv4" && !net.internal)
    .map((net) => net.address)
  return [...addresses.filter(isTailscale), ...addresses.filter((a) => !isTailscale(a)), hostname()]
}

/** What the listener reports; `RemoteAccess` keeps it so the settings page can read it without the listener. */
export interface ListenerReport {
  readonly listening: boolean
  readonly listenError: string | null
  readonly connected: number
}

/**
 * The token phones hold and the state the listener reports. The listener itself lives in `server.ts`,
 * above every service, because it dispatches rpc calls.
 */
export class RemoteAccess extends Context.Service<
  RemoteAccess,
  {
    readonly status: Effect.Effect<RemoteStatus>
    readonly pairing: Effect.Effect<RemotePairing, PersistenceError>
    readonly rotateToken: Effect.Effect<RemotePairing, PersistenceError>
    /** Constant-time comparison against the current token. */
    readonly authenticate: (token: string) => boolean
    /** Fires after each rotation, so the listener can drop every socket. */
    readonly rotations: Stream.Stream<void>
    readonly report: (patch: Partial<ListenerReport>) => Effect.Effect<void>
    readonly identity: EnvironmentIdentity
  }
>()("kkcode/RemoteAccess") {}

const loadIdentity = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`INSERT INTO setting (key, value) VALUES (${ENVIRONMENT_ID_KEY}, ${randomUUID()}) ON CONFLICT (key) DO NOTHING`
  const [row] = yield* sql<{ value: string }>`SELECT value FROM setting WHERE key = ${ENVIRONMENT_ID_KEY}`
  return { id: row!.value, name: hostname() }
}).pipe(Effect.mapError(persistence("remote.identity")))

const make = Effect.gen(function* () {
  const secrets = yield* Secrets
  const identity = yield* loadIdentity
  const settings = yield* Settings
  const rotated = yield* PubSub.unbounded<void>()
  let token = Option.getOrNull(yield* secrets.get(REMOTE_TOKEN_SECRET))
  let report: ListenerReport = { listening: false, listenError: null, connected: 0 }

  const pairingFor = (current: string) =>
    Effect.map(settings.get, ({ remote }) => ({
      hosts: reachableHosts(remote.bindHost),
      port: remote.port,
      token: current,
    }))

  const rotateToken = Effect.gen(function* () {
    const next = randomBytes(32).toString("base64url")
    yield* secrets.set(REMOTE_TOKEN_SECRET, next)
    token = next
    yield* PubSub.publish(rotated, undefined)
    return yield* pairingFor(next)
  })

  return RemoteAccess.of({
    status: Effect.sync(() => report),
    pairing: Effect.suspend(() => (token === null ? rotateToken : pairingFor(token))),
    rotateToken,
    authenticate: (candidate) => {
      if (token === null) return false
      const expected = Buffer.from(token)
      const given = Buffer.from(candidate)
      return expected.length === given.length && timingSafeEqual(expected, given)
    },
    rotations: Stream.fromPubSub(rotated),
    report: (patch) => Effect.sync(() => void (report = { ...report, ...patch })),
    identity,
  })
})

export const layer = Layer.effect(RemoteAccess, make)
