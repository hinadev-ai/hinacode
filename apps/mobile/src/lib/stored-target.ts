import { Option, Schema } from "effect"
import { encodeKey } from "@shared/noise.ts"
import { EntrySource } from "@shared/relayMachines.ts"
import { type PairingTarget, pairingUrl, parsePairingUrl } from "@shared/remote.ts"

export const SERVERS_KEY = "hinacode.servers"
export const LEGACY_KEY = "hinacode.connection"

export interface StoredServer extends Omit<PairingTarget, "key"> {
  readonly id: string
  readonly name: string | null
  readonly environmentId: string | null
  readonly key: string | null
  readonly verified: boolean
  readonly source: EntrySource
}

const Entry = Schema.Struct({
  id: Schema.String,
  name: Schema.NullOr(Schema.String),
  environmentId: Schema.NullOr(Schema.String),
  hosts: Schema.NonEmptyArray(Schema.String),
  port: Schema.Int,
  key: Schema.optionalKey(Schema.NullOr(Schema.String)),
  secret: Schema.optionalKey(Schema.NullOr(Schema.String)),
  verified: Schema.optionalKey(Schema.Boolean),
  relay: Schema.optionalKey(Schema.NullOr(Schema.String)),
  source: Schema.optionalKey(EntrySource),
})

const Legacy = Schema.Union([
  Schema.Struct({ hosts: Schema.NonEmptyArray(Schema.String), port: Schema.Int }),
  Schema.Struct({ host: Schema.String, port: Schema.Int }),
])

const decodeList = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Array(Schema.Unknown)))
const decodeEntry = Schema.decodeUnknownOption(Entry)
const decodeLegacy = Schema.decodeUnknownOption(Schema.fromJsonString(Legacy))

const UNKNOWN_KEY = encodeKey(new Uint8Array(32))

type StoredTarget = Pick<StoredServer, "hosts" | "port" | "relay" | "key" | "secret">

const validTarget = (target: StoredTarget): StoredTarget | null => {
  const valid = parsePairingUrl(pairingUrl({ ...target, key: target.key ?? UNKNOWN_KEY }))
  return valid === null ? null : { ...valid, key: target.key }
}

const validEntry = (raw: unknown): StoredServer[] => {
  const entry = Option.getOrNull(decodeEntry(raw))
  if (entry === null) return []
  const target = validTarget({ ...entry, relay: entry.relay ?? null, key: entry.key ?? null, secret: entry.secret ?? null })
  return target === null
    ? []
    : [
        {
          id: entry.id,
          name: entry.name,
          environmentId: entry.environmentId,
          ...target,
          verified: entry.verified ?? false,
          source: entry.source ?? "pairing",
        },
      ]
}

const migrate = (legacy: string | null, newId: () => string): StoredServer[] => {
  const stored = legacy === null ? null : Option.getOrNull(decodeLegacy(legacy))
  if (stored === null) return []
  const target = validTarget({
    hosts: "host" in stored ? [stored.host] : stored.hosts,
    port: stored.port,
    relay: null,
    key: null,
    secret: null,
  })
  return target === null
    ? []
    : [{ id: newId(), name: null, environmentId: null, ...target, verified: false, source: "pairing" }]
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
    const added: StoredServer = {
      id: newId(),
      name: null,
      environmentId: null,
      ...target,
      verified: true,
      source: "pairing",
    }
    return { servers: [...servers, added], id: added.id }
  }
  return {
    servers: servers.map((server) => (server === same ? { ...server, ...target, verified: true } : server)),
    id: same.id,
  }
}
