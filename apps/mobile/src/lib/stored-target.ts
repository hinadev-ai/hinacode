import { Option, Schema } from "effect"
import { type PairingTarget, pairingUrl, parsePairingUrl } from "@shared/remote.ts"

export const SERVERS_KEY = "hinacode.servers"
/** Where an app from before the server list kept its one pairing. Read once, then deleted. */
export const LEGACY_KEY = "hinacode.connection"

/**
 * A paired HinaCode. `id` is made by this phone, so calls can route before the first handshake. `name` and
 * `environmentId` come from the server's first `ready` frame.
 */
export interface StoredServer extends PairingTarget {
  readonly id: string
  readonly name: string | null
  readonly environmentId: string | null
}

const Entry = Schema.Struct({
  id: Schema.String,
  name: Schema.NullOr(Schema.String),
  environmentId: Schema.NullOr(Schema.String),
  hosts: Schema.NonEmptyArray(Schema.String),
  port: Schema.Int,
  token: Schema.String,
})

const Legacy = Schema.Union([
  Schema.Struct({ hosts: Schema.NonEmptyArray(Schema.String), port: Schema.Int, token: Schema.String }),
  Schema.Struct({ host: Schema.String, port: Schema.Int, token: Schema.String }),
])

const decodeList = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Array(Schema.Unknown)))
const decodeEntry = Schema.decodeUnknownOption(Entry)
const decodeLegacy = Schema.decodeUnknownOption(Schema.fromJsonString(Legacy))

/** The pairing schema checks types only; the pairing URL parser also refuses hosts and ports no socket can use. */
const validTarget = (target: PairingTarget) => parsePairingUrl(pairingUrl(target))

const validEntry = (raw: unknown): StoredServer[] => {
  const entry = Option.getOrNull(decodeEntry(raw))
  const target = entry === null ? null : validTarget(entry)
  return entry === null || target === null ? [] : [{ ...entry, ...target }]
}

const migrate = (legacy: string | null, newId: () => string): StoredServer[] => {
  const stored = legacy === null ? null : Option.getOrNull(decodeLegacy(legacy))
  if (stored === null) return []
  const target = validTarget(
    "host" in stored ? { hosts: [stored.host], port: stored.port, token: stored.token } : stored,
  )
  return target === null ? [] : [{ id: newId(), name: null, environmentId: null, ...target }]
}

export const newServerId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

/** Reads the server list, or the single pairing an older app saved when there is no list yet. */
export function parseStoredServers(raw: string | null, legacy: string | null, newId: () => string) {
  if (raw === null) return migrate(legacy, newId)
  return Option.getOrElse(decodeList(raw), () => []).flatMap(validEntry)
}

/**
 * Adds a pairing, or updates the server it pairs with again: the same port and an address in common, as after
 * the token was rotated. Returns the list and the id of the server it reaches.
 */
export function addPairing(servers: readonly StoredServer[], target: PairingTarget, newId: () => string) {
  const same = servers.find(
    (server) => server.port === target.port && server.hosts.some((host) => target.hosts.includes(host)),
  )
  if (same === undefined) {
    const id = newId()
    return { servers: [...servers, { id, name: null, environmentId: null, ...target }], id }
  }
  return {
    servers: servers.map((server) =>
      server === same ? { ...server, hosts: target.hosts, token: target.token } : server,
    ),
    id: same.id,
  }
}
