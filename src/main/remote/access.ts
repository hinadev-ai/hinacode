import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto"
import { hostname, networkInterfaces } from "node:os"
import { Array as Arr, Context, Effect, Layer, Option, PubSub, Stream } from "effect"
import type { NonEmptyReadonlyArray } from "effect/Array"
import { SqlClient } from "effect/sql"
import type { NetworkAddress, RelayStatus, RemotePairing, RemoteStatus } from "../../shared/domain.ts"
import { clientProof, serverProof } from "../../shared/proof.ts"
import { type PersistenceError, persistence } from "../services/errors.ts"
import { Secrets } from "../services/Secrets.ts"
import { Settings } from "../services/Settings.ts"

export const REMOTE_TOKEN_SECRET = "remote.token"
const ENVIRONMENT_ID_KEY = "environment.id"

/** Who this hinacode is to a desktop that pairs with it. The id is made once per data directory. */
export interface EnvironmentIdentity {
  readonly id: string
  readonly name: string
}

/** Close codes a client can tell apart from a network drop. Only the first two mean "pair again"; retry the rest. */
export const CLOSE_UNAUTHORIZED = 4001
export const CLOSE_TOKEN_ROTATED = 4002
export const CLOSE_LISTENER_STOPPED = 4003
export const CLOSE_AUTH_TIMEOUT = 4004
export const CLOSE_MALFORMED_FRAME = 4005
export const CLOSE_SLOW_CONSUMER = 4006

const isTailscale = (address: string) => address.startsWith("100.")

/** Bridges into containers and VMs on this machine, which no phone or other desktop can route to. */
const isVirtualBridge = (name: string) => /^(docker|br-|veth|virbr|cni|flannel|podman|vboxnet|vmnet)/.test(name)

/** IPv4 addresses on this machine a phone could reach, Tailscale first. Nothing on loopback, since a phone is never on it. */
export const networkAddresses = (
  interfaces: ReturnType<typeof networkInterfaces> = networkInterfaces(),
): ReadonlyArray<NetworkAddress> => {
  const addresses = Object.entries(interfaces)
    .filter(([name]) => !isVirtualBridge(name))
    .flatMap(([name, nets]) =>
      (nets ?? [])
        .filter((net) => net.family === "IPv4" && !net.internal)
        .map((net) => ({ name, address: net.address })),
    )
  return [...addresses.filter((a) => isTailscale(a.address)), ...addresses.filter((a) => !isTailscale(a.address))]
}

/** Where a phone should try to reach a listener bound to `bindHost`, in order. */
export const reachableHosts = (
  bindHost: string,
  interfaces: ReturnType<typeof networkInterfaces> = networkInterfaces(),
  host: string = hostname(),
): NonEmptyReadonlyArray<string> => {
  if (bindHost !== "0.0.0.0" && bindHost !== "::") return [bindHost]
  return Arr.append(
    networkAddresses(interfaces).map((a) => a.address),
    host,
  )
}

/** The tunnel hostname clients should dial first, kept while the relay is paused or failing so pairings keep it. */
export const relayHostname = (relay: RelayStatus) => ("hostname" in relay ? relay.hostname : null)

/**
 * The token phones hold and the state the listener and the relay report. The listener itself lives in `server.ts`,
 * above every service, because it dispatches rpc calls.
 */
export class RemoteAccess extends Context.Service<
  RemoteAccess,
  {
    readonly status: Effect.Effect<RemoteStatus>
    readonly pairing: Effect.Effect<RemotePairing, PersistenceError>
    readonly rotateToken: Effect.Effect<RemotePairing, PersistenceError>
    /** Constant-time comparison against the current token, for clients that predate the challenge. */
    readonly authenticate: (token: string) => boolean
    /**
     * Checks a client's `clientProof` for this socket's nonces against the current token in constant time, and
     * answers the `serverProof` its `ready` carries, or null when the proof is wrong.
     */
    readonly answerChallenge: (serverNonce: string, clientNonce: string, proof: string) => string | null
    /** Counts rotations, so a socket can tell whether the token it authenticated with is still current. */
    readonly generation: () => number
    /** Fires after each rotation, so the listener can drop every socket. */
    readonly rotations: Stream.Stream<void>
    /** The listener reports `listening`, `listenError` and `connected`; the relay reports `relay`. */
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
      hosts: reachableHosts(remote.bindHost),
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
