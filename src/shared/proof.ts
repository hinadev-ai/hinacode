import { hmac } from "@noble/hashes/hmac.js"
import { sha256 } from "@noble/hashes/sha2.js"
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js"

const prove = (token: string, label: string, first: string, second: string) =>
  bytesToHex(hmac(sha256, utf8ToBytes(token), utf8ToBytes(`hinacode ${label}\n${first}\n${second}`)))

export const clientProof = (token: string, serverNonce: string, clientNonce: string) =>
  prove(token, "client", serverNonce, clientNonce)

export const serverProof = (token: string, clientNonce: string, serverNonce: string) =>
  prove(token, "server", clientNonce, serverNonce)

export const newNonce = () => {
  const bytes = new Uint8Array(32)
  // FIXME: Hermes has no WebCrypto, and a client nonce only has to be fresh
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes)
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256)
  return bytesToHex(bytes)
}
