import { Option, Schema } from "effect"
import { decodeKey, encodeKey, generateKeyPair, type KeyPair, keyPairFromSecret } from "../../../src/shared/noise.ts"

const DEVICE_KEY = "hinacode.deviceKey"
const HOST_KEYS = "hinacode.hostKeys"

export const deviceKey = (): KeyPair => {
  const stored = decodeKey(localStorage.getItem(DEVICE_KEY) ?? "")
  if (stored !== null) return keyPairFromSecret(stored)
  const created = generateKeyPair()
  localStorage.setItem(DEVICE_KEY, encodeKey(created.secretKey))
  return created
}

const decodeHostKeys = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Record(Schema.String, Schema.String)))

const hostKeys = (): Readonly<Record<string, string>> =>
  Option.getOrElse(decodeHostKeys(localStorage.getItem(HOST_KEYS) ?? ""), () => ({}))

const saveHostKeys = (keys: Readonly<Record<string, string>>) => localStorage.setItem(HOST_KEYS, JSON.stringify(keys))

export const pinnedKey = (environmentId: string): string | null => hostKeys()[environmentId] ?? null

export const pinKey = (environmentId: string, key: string) => saveHostKeys({ ...hostKeys(), [environmentId]: key })

export const unpinKey = (environmentId: string) => {
  const { [environmentId]: _, ...rest } = hostKeys()
  saveHostKeys(rest)
}
