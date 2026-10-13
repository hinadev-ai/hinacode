import { randomBytes, timingSafeEqual } from "node:crypto"
import { hostname, networkInterfaces } from "node:os"
import { Context, Effect, Layer, Option, PubSub, Stream } from "effect"
import type { RemotePairing, RemoteStatus } from "../../shared/domain.ts"
import type { PersistenceError } from "../services/errors.ts"
import { Secrets } from "../services/Secrets.ts"
import { Settings } from "../services/Settings.ts"

export const REMOTE_TOKEN_SECRET = "remote.token"

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
  }
>()("kkcode/RemoteAccess") {}

const make = Effect.gen(function* () {
  const secrets = yield* Secrets
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
  })
})

export const layer = Layer.effect(RemoteAccess, make)
