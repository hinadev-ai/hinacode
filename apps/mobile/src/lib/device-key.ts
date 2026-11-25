import { decodeKey, encodeKey, generateKeyPair, type KeyPair, keyPairFromSecret } from "@shared/noise.ts"

export const DEVICE_KEY = "hinacode.deviceKey"

export const readDeviceKey = (stored: string | null): KeyPair | null => {
  const secret = stored === null ? null : decodeKey(stored)
  return secret === null ? null : keyPairFromSecret(secret)
}

export const newDeviceKey = () => {
  const key = generateKeyPair()
  return { key, stored: encodeKey(key.secretKey) }
}
