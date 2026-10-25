import { Option, Schema } from "effect"
import { EntrySource } from "@shared/relayMachines.ts"
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
  readonly source: EntrySource
}

const Entry = Schema.Struct({
  id: Schema.String,
  name: Schema.NullOr(Schema.String),
  environmentId: Schema.NullOr(Schema.String),
  hosts: Schema.NonEmptyArray(Schema.String),
  port: Schema.Int,
  token: Schema.String,
  /** Absent in entries saved before the relay existed. */
  relay: Schema.optionalKey(Schema.NullOr(Schema.String)),
  /** Absent in entries saved before the relay listed machines. */
  source: Schema.optionalKey(EntrySource),
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
  const target = entry === null ? null : validTarget({ ...entry, relay: entry.relay ?? null })
  return entry === null || target === null ? [] : [{ ...entry, ...target, source: entry.source ?? "pairing" }]
}

const migrate = (legacy: string | null, newId: () => string): StoredServer[] => {
  const stored = legacy === null ? null : Option.getOrNull(decodeLegacy(legacy))
  if (stored === null) return []
  const target = validTarget(
    "host" in stored
      ? { hosts: [stored.host], port: stored.port, token: stored.token, relay: null }
      : { ...stored, relay: null },
  )
  return target === null ? [] : [{ id: newId(), name: null, environmentId: null, ...target, source: "pairing" }]
}

export const newServerId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

/** Reads the server list, or the single pairing an older app saved when there is no list yet. */
export function parseStoredServers(raw: string | null, legacy: string | null, newId: () => string) {
  if (raw === null) return migrate(legacy, newId)
  return Option.getOrElse(decodeList(raw), () => []).flatMap(validEntry)
}

/**
 * Adds a pairing, or updates the server it pairs with again: the same relay, or the same port and an address in
 * common, as after the token was rotated. Returns the list and the id of the server it reaches.
 */
export function addPairing(servers: readonly StoredServer[], target: PairingTarget, newId: () => string) {
  const same = servers.find(
    (server) =>
      (target.relay !== null && server.relay === target.relay) ||
      (server.port === target.port && server.hosts.some((host) => target.hosts.includes(host))),
  )
  if (same === undefined) {
    const added: StoredServer = { id: newId(), name: null, environmentId: null, ...target, source: "pairing" }
    return { servers: [...servers, added], id: added.id }
  }
  return {
    servers: servers.map((server) => (server === same ? { ...server, ...target } : server)),
    id: same.id,
  }
}
