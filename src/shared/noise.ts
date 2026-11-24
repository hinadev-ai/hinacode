import { chacha20poly1305 } from "@noble/ciphers/chacha.js"
import { x25519 } from "@noble/curves/ed25519.js"
import { hkdf } from "@noble/hashes/hkdf.js"
import { sha256 } from "@noble/hashes/sha2.js"
import { concatBytes, randomBytes, utf8ToBytes } from "@noble/hashes/utils.js"
import { Result } from "effect"
import { Base64Url } from "effect/encoding"

export { equalBytes as sameBytes } from "@noble/ciphers/utils.js"

export const REMOTE_PROLOGUE = utf8ToBytes("hinacode remote 2")

const PROTOCOL_NAME = utf8ToBytes("Noise_IK_25519_ChaChaPoly_SHA256")
const KEY_BYTES = 32
const TAG_BYTES = 16
const MAX_HANDSHAKE_MESSAGE_BYTES = 65535
const APPROVAL_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

export interface KeyPair {
  readonly publicKey: Uint8Array
  readonly secretKey: Uint8Array
}

export const keyPairFromSecret = (secretKey: Uint8Array): KeyPair => ({
  publicKey: x25519.getPublicKey(secretKey),
  secretKey,
})

export const generateKeyPair = (): KeyPair => keyPairFromSecret(x25519.utils.randomSecretKey())

export interface Channel {
  readonly handshakeHash: Uint8Array
  encrypt(plaintext: Uint8Array): Uint8Array
  decrypt(ciphertext: Uint8Array): Uint8Array
}

const nonceFor = (counter: number) => {
  const nonce = new Uint8Array(12)
  const view = new DataView(nonce.buffer)
  view.setUint32(4, counter % 2 ** 32, true)
  view.setUint32(8, Math.floor(counter / 2 ** 32), true)
  return nonce
}

type CipherState = ReturnType<typeof cipherState>

const cipherState = (key: Uint8Array) => {
  let counter = 0
  const aead = (associatedData?: Uint8Array) => chacha20poly1305(key, nonceFor(counter), associatedData)
  return {
    encrypt(plaintext: Uint8Array, associatedData?: Uint8Array) {
      const ciphertext = aead(associatedData).encrypt(plaintext)
      counter += 1
      return ciphertext
    },
    decrypt(ciphertext: Uint8Array, associatedData?: Uint8Array) {
      const plaintext = aead(associatedData).decrypt(ciphertext)
      counter += 1
      return plaintext
    },
  }
}

const channel = (sending: CipherState, receiving: CipherState, handshakeHash: Uint8Array): Channel => {
  let failed = false
  const guard = <A>(step: () => A) => {
    if (failed) throw new Error("Noise: the channel failed to decrypt a frame and is closed")
    try {
      return step()
    } catch (error) {
      failed = true
      throw error
    }
  }
  return {
    handshakeHash,
    encrypt: (plaintext) => guard(() => sending.encrypt(plaintext)),
    decrypt: (ciphertext) => guard(() => receiving.decrypt(ciphertext)),
  }
}

const symmetricState = (prologue: Uint8Array) => {
  let chainingKey: Uint8Array = PROTOCOL_NAME
  let hash: Uint8Array = PROTOCOL_NAME
  let cipher: CipherState | undefined
  const keyed = () => {
    if (!cipher) throw new Error("Noise: no key mixed in yet")
    return cipher
  }
  const mixHash = (data: Uint8Array) => {
    hash = sha256(concatBytes(hash, data))
  }
  const deriveKeys = (inputKeyMaterial: Uint8Array) => {
    const output = hkdf(sha256, inputKeyMaterial, chainingKey, undefined, 2 * KEY_BYTES)
    return [output.subarray(0, KEY_BYTES), output.subarray(KEY_BYTES)] as const
  }
  mixHash(prologue)
  return {
    mixHash,
    mixKey(inputKeyMaterial: Uint8Array) {
      const [nextChainingKey, key] = deriveKeys(inputKeyMaterial)
      chainingKey = nextChainingKey
      cipher = cipherState(key)
    },
    encryptAndHash(plaintext: Uint8Array) {
      const ciphertext = keyed().encrypt(plaintext, hash)
      mixHash(ciphertext)
      return ciphertext
    },
    decryptAndHash(ciphertext: Uint8Array) {
      const plaintext = keyed().decrypt(ciphertext, hash)
      mixHash(ciphertext)
      return plaintext
    },
    split(role: "initiator" | "responder") {
      const [initiatorKey, responderKey] = deriveKeys(new Uint8Array(0))
      const initiatorToResponder = cipherState(initiatorKey)
      const responderToInitiator = cipherState(responderKey)
      return role === "initiator"
        ? channel(initiatorToResponder, responderToInitiator, hash)
        : channel(responderToInitiator, initiatorToResponder, hash)
    },
  }
}

const dh = (local: KeyPair, remotePublicKey: Uint8Array) => x25519.getSharedSecret(local.secretKey, remotePublicKey)

const handshakeMessage = (message: Uint8Array, minimumBytes = 0) => {
  if (message.length < minimumBytes || message.length > MAX_HANDSHAKE_MESSAGE_BYTES) {
    throw new Error(`Noise: a handshake message must be ${minimumBytes} to ${MAX_HANDSHAKE_MESSAGE_BYTES} bytes`)
  }
  return message
}

const once = <A, B>(step: (input: A) => B) => {
  let ran = false
  return (input: A) => {
    if (ran) throw new Error("Noise: a handshake step runs once")
    ran = true
    return step(input)
  }
}

export const initiate = (input: {
  readonly prologue: Uint8Array
  readonly local: KeyPair
  readonly remoteStatic: Uint8Array
  readonly payload: Uint8Array
  readonly ephemeral?: KeyPair
}) => {
  const { local, remoteStatic } = input
  if (remoteStatic.length !== KEY_BYTES) throw new Error(`Noise: the remote static key must be ${KEY_BYTES} bytes`)
  const ephemeral = input.ephemeral ?? generateKeyPair()
  const state = symmetricState(input.prologue)
  state.mixHash(remoteStatic)

  state.mixHash(ephemeral.publicKey)
  state.mixKey(dh(ephemeral, remoteStatic))
  const encryptedStatic = state.encryptAndHash(local.publicKey)
  state.mixKey(dh(local, remoteStatic))
  const message = handshakeMessage(
    concatBytes(ephemeral.publicKey, encryptedStatic, state.encryptAndHash(input.payload)),
  )

  return {
    message,
    finish: once((reply: Uint8Array) => {
      handshakeMessage(reply, KEY_BYTES + TAG_BYTES)
      const remoteEphemeral = reply.slice(0, KEY_BYTES)
      state.mixHash(remoteEphemeral)
      state.mixKey(dh(ephemeral, remoteEphemeral))
      state.mixKey(dh(local, remoteEphemeral))
      const payload = state.decryptAndHash(reply.subarray(KEY_BYTES))
      return { payload, channel: state.split("initiator") }
    }),
  }
}

export const respond = (input: {
  readonly prologue: Uint8Array
  readonly local: KeyPair
  readonly message: Uint8Array
  readonly ephemeral?: KeyPair
}) => {
  const { local } = input
  const message = handshakeMessage(input.message, 2 * KEY_BYTES + 2 * TAG_BYTES)
  const state = symmetricState(input.prologue)
  state.mixHash(local.publicKey)

  const remoteEphemeral = message.slice(0, KEY_BYTES)
  state.mixHash(remoteEphemeral)
  state.mixKey(dh(local, remoteEphemeral))
  const remoteStatic = state.decryptAndHash(message.subarray(KEY_BYTES, 2 * KEY_BYTES + TAG_BYTES))
  state.mixKey(dh(local, remoteStatic))
  const payload = state.decryptAndHash(message.subarray(2 * KEY_BYTES + TAG_BYTES))

  return {
    remoteStatic,
    payload,
    reply: once((replyPayload: Uint8Array) => {
      const ephemeral = input.ephemeral ?? generateKeyPair()
      state.mixHash(ephemeral.publicKey)
      state.mixKey(dh(ephemeral, remoteEphemeral))
      state.mixKey(dh(ephemeral, remoteStatic))
      const reply = handshakeMessage(concatBytes(ephemeral.publicKey, state.encryptAndHash(replyPayload)))
      return { message: reply, channel: state.split("responder") }
    }),
  }
}

export const newNonce = () => randomBytes(32)

export const commitment = (nonce: Uint8Array) => sha256(nonce)

export const approvalCode = (handshakeHash: Uint8Array, clientNonce: Uint8Array, serverNonce: Uint8Array) => {
  const digest = sha256(concatBytes(handshakeHash, clientNonce, serverNonce))
  const value = Math.floor(digest.subarray(0, 4).reduce((total, byte) => total * 256 + byte, 0) / 4)
  const characters = Array.from({ length: 6 }, (_, index) =>
    APPROVAL_ALPHABET.charAt(Math.floor(value / 32 ** (5 - index)) % 32),
  ).join("")
  return `${characters.slice(0, 3)}-${characters.slice(3)}`
}

export const encodeKey = (key: Uint8Array) => Base64Url.encode(key)

export const decodeKey = (text: string): Uint8Array | null => {
  const key = Result.getOrNull(Base64Url.decode(text))
  return key?.length === KEY_BYTES && encodeKey(key) === text ? key : null
}
