import { Option, Schema } from "effect"
import { EntrySource } from "@shared/relayMachines.ts"
import { type PairingTarget, pairingUrl, parsePairingUrl } from "@shared/remote.ts"

export const SERVERS_KEY = "hinacode.servers"
export const LEGACY_KEY = "hinacode.connection"

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
  relay: Schema.optionalKey(Schema.NullOr(Schema.String)),
  source: Schema.optionalKey(EntrySource),
})

const Legacy = Schema.Union([
  Schema.Struct({ hosts: Schema.NonEmptyArray(Schema.String), port: Schema.Int, token: Schema.String }),
  Schema.Struct({ host: Schema.String, port: Schema.Int, token: Schema.String }),
])

const decodeList = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Array(Schema.Unknown)))
const decodeEntry = Schema.decodeUnknownOption(Entry)
const decodeLegacy = Schema.decodeUnknownOption(Schema.fromJsonString(Legacy))

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

export function parseStoredServers(raw: string | null, legacy: string | null, newId: () => string) {
  if (raw === null) return migrate(legacy, newId)
  return Option.getOrElse(decodeList(raw), () => []).flatMap(validEntry)
}

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
