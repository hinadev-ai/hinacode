import { hmac } from "@noble/hashes/hmac.js"
import { sha256 } from "@noble/hashes/sha2.js"
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js"

/**
 * Proofs that a client and a server hold the same pairing token, so the token itself never crosses the wire. The
 * server sends a nonce first; the client answers with `clientProof` and a nonce of its own; the server's `ready`
 * carries `serverProof`. A stranger at the machine's address learns neither the token nor a proof it can reuse.
 */
const prove = (token: string, label: string, first: string, second: string) =>
  bytesToHex(hmac(sha256, utf8ToBytes(token), utf8ToBytes(`hinacode ${label}\n${first}\n${second}`)))

export const clientProof = (token: string, serverNonce: string, clientNonce: string) =>
  prove(token, "client", serverNonce, clientNonce)

export const serverProof = (token: string, clientNonce: string, serverNonce: string) =>
  prove(token, "server", clientNonce, serverNonce)

export const newNonce = () => {
  const bytes = new Uint8Array(32)
  // Hermes has no WebCrypto without a polyfill. A client's nonce only has to be fresh, and the server's always
  // comes from Node's crypto.
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes)
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256)
  return bytesToHex(bytes)
}
