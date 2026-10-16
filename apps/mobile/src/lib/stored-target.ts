import { Option, Schema } from "effect"
import { type PairingTarget, pairingUrl, parsePairingUrl } from "@shared/remote.ts"

export const STORAGE_KEY = "hinacode.connection"

const Stored = Schema.Union([
  Schema.Struct({ hosts: Schema.NonEmptyArray(Schema.String), port: Schema.Int, token: Schema.String }),
  Schema.Struct({ host: Schema.String, port: Schema.Int, token: Schema.String }),
])

const decode = Schema.decodeUnknownOption(Schema.fromJsonString(Stored))

export const parseStoredTarget = (raw: string | null): PairingTarget | null => {
  if (raw === null) return null
  const stored = Option.getOrNull(decode(raw))
  if (stored === null) return null
  const target = "host" in stored ? { hosts: [stored.host] as const, port: stored.port, token: stored.token } : stored
  return parsePairingUrl(pairingUrl(target))
}
