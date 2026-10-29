import { getRandomValues } from "expo-crypto"

// Hermes has no WebCrypto, and each socket's X25519 key pair draws from `crypto.getRandomValues`, which noble only
// calls with a Uint8Array.
globalThis.crypto ??= {} as Crypto
globalThis.crypto.getRandomValues ??= getRandomValues as Crypto["getRandomValues"]
