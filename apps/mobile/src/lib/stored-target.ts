import { Option, Schema } from "effect"
import type { PairingTarget } from "@shared/remote.ts"

export const STORAGE_KEY = "kkcode.connection"

const decode = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ host: Schema.String, port: Schema.Int, token: Schema.String })),
)

export const parseStoredTarget = (raw: string | null): PairingTarget | null =>
  raw === null ? null : Option.getOrNull(decode(raw))
