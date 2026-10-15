import { Option, Schema } from "effect"
import type { PairingTarget } from "@shared/remote.ts"

export const STORAGE_KEY = "kkcode.connection"

const Stored = Schema.Union([
  Schema.Struct({ hosts: Schema.NonEmptyArray(Schema.String), port: Schema.Int, token: Schema.String }),
  /** Saved before a pairing carried every address. */
  Schema.Struct({ host: Schema.String, port: Schema.Int, token: Schema.String }),
])

const decode = Schema.decodeUnknownOption(Schema.fromJsonString(Stored))

export const parseStoredTarget = (raw: string | null): PairingTarget | null => {
  if (raw === null) return null
  const stored = Option.getOrNull(decode(raw))
  if (stored === null || !("host" in stored)) return stored
  return { hosts: [stored.host], port: stored.port, token: stored.token }
}
