import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto"
import { hostname } from "node:os"
import { Clock, Context, Effect, Layer, Option, PubSub, Schema, Stream } from "effect"
import { SqlClient, SqlSchema } from "effect/sql"
import { isReadonlyArrayNonEmpty, type NonEmptyReadonlyArray } from "effect/Array"
import {
  PRIVATE_NETWORKS,
  type RelayStatus,
  type RemoteDevice,
  type RemoteDevices,
  type RemoteDevicesChange,
  type RemotePairing,
  type RemoteStatus,
} from "../../shared/domain.ts"
import { encodeKey, generateKeyPair, type KeyPair, keyPairFromSecret } from "../../shared/noise.ts"
import { clientProof, serverProof } from "../../shared/proof.ts"
import { CLOSE_UNAUTHORIZED, type LegacyAuth, normalizeApprovalCode } from "../../shared/remote.ts"
import { privateAddresses } from "../network.ts"
import { NoWaitingDeviceError, type PersistenceError, persistence } from "../services/errors.ts"
import { Events } from "../services/Events.ts"
import { Secrets } from "../services/Secrets.ts"
import { Settings } from "../services/Settings.ts"

const HOST_KEY_SECRET = "remote.hostKey"
const PAIRING_SECRET = "remote.pairingSecret"
const LEGACY_TOKEN_SECRET = "remote.token"
const ENVIRONMENT_ID_KEY = "environment.id"
const MAX_WAITING = 8

export interface EnvironmentIdentity {
  readonly id: string
  readonly name: string
}

export interface Hello {
  readonly key: string
  readonly name: string
  readonly secret?: string | undefined
  readonly verify?: boolean | undefined
}

export interface WaitingRequest {
  readonly key: string
  readonly name: string
  readonly admit: () => void
  readonly close: (code: number, reason: string) => void
}

export interface Waiting {
  readonly showsCode: (code: string) => Effect.Effect<void>
  readonly leave: () => void
}

export const LOOPBACK = "127.0.0.1"

export const advertisedHosts = (bindHost: string): NonEmptyReadonlyArray<string> => {
  if (bindHost !== PRIVATE_NETWORKS) return [bindHost]
  const hosts = privateAddresses()
  return isReadonlyArrayNonEmpty(hosts) ? hosts : [LOOPBACK]
}

export const relayHostname = (relay: RelayStatus) => ("hostname" in relay ? relay.hostname : null)

export const appsRelayHostname = (relay: RelayStatus) => {
  const hostname = relayHostname(relay)
  return hostname === null || hostname.includes("/") ? null : hostname
}

export class RemoteAccess extends Context.Service<
  RemoteAccess,
  {
    readonly status: Effect.Effect<RemoteStatus>
    readonly report: (patch: Partial<RemoteStatus>) => Effect.Effect<void>
    readonly identity: EnvironmentIdentity
    readonly hostKey: () => KeyPair
    readonly pairing: Effect.Effect<RemotePairing, PersistenceError>
    readonly resetPairing: Effect.Effect<RemotePairing, PersistenceError>
    readonly resets: Stream.Stream<void>
    readonly answerLegacy: (challenge: string, auth: LegacyAuth) => { readonly proof?: string } | null
    readonly admit: (hello: Hello) => Effect.Effect<"ready" | "pending", PersistenceError>
    readonly wait: (request: WaitingRequest) => Waiting
    readonly connect: (key: string, close: (code: number, reason: string) => void) => () => void
    readonly devices: Effect.Effect<RemoteDevices, PersistenceError>
    readonly approve: (code: string) => Effect.Effect<RemoteDevice, NoWaitingDeviceError | PersistenceError>
    readonly remove: (key: string) => Effect.Effect<void, PersistenceError>
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

const newSecret = () => randomBytes(32).toString("base64url")

const encodeSecretKey = (key: KeyPair) => Buffer.from(key.secretKey).toString("base64url")

const DeviceRow = Schema.Struct({
  key: Schema.String,
  name: Schema.String,
  createdAt: Schema.Number,
  lastSeenAt: Schema.NullOr(Schema.Number),
})
type DeviceRow = typeof DeviceRow.Type

interface Pending extends WaitingRequest {
  code: string | null
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const secrets = yield* Secrets
  const settings = yield* Settings
  const events = yield* Events
  const identity = yield* loadIdentity
  const resets = yield* PubSub.unbounded<void>()

  const storedHostKey = Option.getOrNull(yield* secrets.get(HOST_KEY_SECRET))
  const storedSecret = Option.getOrNull(yield* secrets.get(PAIRING_SECRET))
  let hostKey = storedHostKey === null ? generateKeyPair() : keyPairFromSecret(Buffer.from(storedHostKey, "base64url"))
  let secret = storedHostKey === null || storedSecret === null ? newSecret() : storedSecret
  if (storedHostKey === null) yield* secrets.set(HOST_KEY_SECRET, encodeSecretKey(hostKey))
  if (storedSecret !== secret) yield* secrets.set(PAIRING_SECRET, secret)
  const legacyToken = Option.getOrNull(yield* secrets.get(LEGACY_TOKEN_SECRET))

  let report: RemoteStatus = { listening: false, listenError: null, connected: 0, relay: { state: "off" } }
  const live = new Map<string, Set<(code: number, reason: string) => void>>()
  const pending: Array<Pending> = []

  const findDevice = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: DeviceRow,
    execute: (key) => sql`SELECT key, name, created_at, last_seen_at FROM remote_device WHERE key = ${key}`,
  })
  const findDevices = SqlSchema.findAll({
    Request: Schema.Void,
    Result: DeviceRow,
    execute: () => sql`SELECT key, name, created_at, last_seen_at FROM remote_device ORDER BY created_at, rowid`,
  })

  const changed = (reason: RemoteDevicesChange, name?: string) =>
    events.publish({ type: "remote.devices.changed", reason, ...(name !== undefined && { name }) })

  const withConnected = (row: DeviceRow): RemoteDevice => ({ ...row, connected: live.has(row.key) })

  const trust = (key: string, name: string) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis
      const [row] = yield* sql<DeviceRow>`
        INSERT INTO remote_device (key, name, created_at, last_seen_at) VALUES (${key}, ${name}, ${now}, ${now})
        ON CONFLICT (key) DO UPDATE SET last_seen_at = excluded.last_seen_at
        RETURNING key, name, created_at, last_seen_at
      `
      return row!
    }).pipe(Effect.mapError(persistence("remote.trust")))

  const touch = (key: string) =>
    Effect.flatMap(
      Clock.currentTimeMillis,
      (now) => sql`UPDATE remote_device SET last_seen_at = ${now} WHERE key = ${key}`,
    ).pipe(Effect.mapError(persistence("remote.touch")))

  const replaceSecret = () => {
    secret = newSecret()
    return secrets.set(PAIRING_SECRET, secret)
  }

  const pairing = Effect.map(settings.get, ({ remote }) => ({
    hosts: advertisedHosts(remote.bindHost),
    port: remote.port,
    relay: relayHostname(report.relay),
    key: encodeKey(hostKey.publicKey),
    secret,
  }))

  const leave = (request: Pending) => {
    const index = pending.indexOf(request)
    if (index !== -1) pending.splice(index, 1)
  }

  const closeDevice = (key: string, reason: string) => {
    for (const close of live.get(key) ?? []) close(CLOSE_UNAUTHORIZED, reason)
    for (const request of pending.filter((candidate) => candidate.key === key)) {
      leave(request)
      request.close(CLOSE_UNAUTHORIZED, reason)
    }
  }

  const admit = (hello: Hello) =>
    Effect.gen(function* () {
      if (hello.verify === true) return "pending" as const
      const trusted = yield* findDevice(hello.key).pipe(Effect.mapError(persistence("remote.admit")))
      if (Option.isSome(trusted)) {
        yield* touch(hello.key)
        return "ready" as const
      }
      if (hello.secret === undefined || !sameSecret(secret, hello.secret)) return "pending" as const
      yield* replaceSecret()
      yield* trust(hello.key, hello.name)
      yield* changed("enrolled", hello.name)
      return "ready" as const
    })

  const wait = (request: WaitingRequest): Waiting => {
    const entry: Pending = { ...request, code: null }
    if (pending.length >= MAX_WAITING) {
      const oldest = pending.shift()!
      oldest.close(CLOSE_UNAUTHORIZED, "too many devices are waiting")
    }
    pending.push(entry)
    return {
      showsCode: (code) =>
        Effect.suspend(() => {
          if (!pending.includes(entry)) return Effect.void
          entry.code = code
          return changed("waiting")
        }),
      leave: () => leave(entry),
    }
  }

  const connect = (key: string, close: (code: number, reason: string) => void) => {
    const sessions = live.get(key) ?? new Set()
    sessions.add(close)
    live.set(key, sessions)
    return () => {
      sessions.delete(close)
      if (sessions.size === 0 && live.get(key) === sessions) live.delete(key)
    }
  }

  const devices = Effect.map(findDevices(undefined), (rows) => ({
    devices: rows.map(withConnected),
    waiting: pending.filter((request) => request.code !== null).length,
  })).pipe(Effect.mapError(persistence("remote.devices")))

  const approve = (typed: string) =>
    Effect.gen(function* () {
      const code = normalizeApprovalCode(typed)
      const request = pending.find((candidate) => code !== null && candidate.code === code)
      if (request === undefined) return yield* new NoWaitingDeviceError({ code: typed })
      leave(request)
      const row = yield* trust(request.key, request.name)
      request.admit()
      yield* changed("approved", row.name)
      return withConnected(row)
    })

  const remove = (key: string) =>
    Effect.gen(function* () {
      const [row] = yield* sql<{ name: string }>`DELETE FROM remote_device WHERE key = ${key} RETURNING name`.pipe(
        Effect.mapError(persistence("remote.remove")),
      )
      closeDevice(key, "device removed")
      yield* replaceSecret()
      yield* changed("removed", row?.name)
    })

  const resetPairing = Effect.gen(function* () {
    hostKey = generateKeyPair()
    yield* secrets.set(HOST_KEY_SECRET, encodeSecretKey(hostKey))
    yield* replaceSecret()
    yield* sql`DELETE FROM remote_device`.pipe(Effect.mapError(persistence("remote.resetPairing")))
    pending.length = 0
    yield* PubSub.publish(resets, undefined)
    yield* changed("reset")
    return yield* pairing
  })

  return RemoteAccess.of({
    status: Effect.sync(() => report),
    report: (patch) => Effect.sync(() => void (report = { ...report, ...patch })),
    identity,
    hostKey: () => hostKey,
    pairing,
    resetPairing,
    resets: Stream.fromPubSub(resets),
    answerLegacy: (challenge, auth) => {
      if (legacyToken === null) return null
      if ("token" in auth) return sameSecret(legacyToken, auth.token) ? {} : null
      return sameSecret(clientProof(legacyToken, challenge, auth.nonce), auth.proof)
        ? { proof: serverProof(legacyToken, auth.nonce, challenge) }
        : null
    },
    admit,
    wait,
    connect,
    devices,
    approve,
    remove,
  })
})

export const layer = Layer.effect(RemoteAccess, make)
