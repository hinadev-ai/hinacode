import { chacha20poly1305 } from "@noble/ciphers/chacha.js"
import { bytesToUtf8 } from "@noble/ciphers/utils.js"
import { x25519 } from "@noble/curves/ed25519.js"
import { hkdf } from "@noble/hashes/hkdf.js"
import { hmac } from "@noble/hashes/hmac.js"
import { sha256 } from "@noble/hashes/sha2.js"
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js"
import { Option, Schema } from "effect"
import { type ClientFrame, REMOTE_PROTOCOL_VERSION, ServerFrame } from "./remote.ts"

/**
 * The remote handshake and the encryption of every frame after it. Each side makes a fresh X25519 key pair per
 * socket and sends its public key as its nonce. Each side proves the pairing token over both keys, so the token never
 * crosses the wire, and the keys for each direction mix the X25519 secret with the token. Whoever carries the socket,
 * such as Cloudflare's edge or a stranger on the same network, can neither read a frame nor answer for the machine.
 * Fresh key pairs mean a token that leaks later does not open sockets recorded before.
 */

export interface KeyPair {
  readonly secretKey: Uint8Array
  /** Hex, the nonce this side sends. */
  readonly publicKey: string
}

export const newKeyPair = (): KeyPair => {
  const { secretKey, publicKey } = x25519.keygen()
  return { secretKey, publicKey: bytesToHex(publicKey) }
}

const prove = (token: string, label: string, first: string, second: string) =>
  bytesToHex(hmac(sha256, utf8ToBytes(token), utf8ToBytes(`hinacode ${label}\n${first}\n${second}`)))

export const clientProof = (token: string, serverNonce: string, clientNonce: string) =>
  prove(token, "client", serverNonce, clientNonce)

export const serverProof = (token: string, clientNonce: string, serverNonce: string) =>
  prove(token, "server", clientNonce, serverNonce)

/** One socket's encryption, both directions. Frames must be opened in the order the peer sealed them. */
export interface Channel {
  readonly seal: (text: string) => Uint8Array
  /** Null when the peer did not seal `sealed` as its next frame, so the socket must close. */
  readonly open: (sealed: Uint8Array) => string | null
}

/** A ChaCha20-Poly1305 nonce from a frame counter, which neither side sends since a WebSocket keeps order. */
const counterNonce = (counter: number) => {
  const nonce = new Uint8Array(12)
  const view = new DataView(nonce.buffer)
  view.setUint32(4, Math.floor(counter / 2 ** 32))
  view.setUint32(8, counter >>> 0)
  return nonce
}

/** Derives the socket's keys, or null when `peerNonce` is not a usable X25519 public key. */
export const openChannel = (
  side: "client" | "server",
  token: string,
  own: KeyPair,
  peerNonce: string,
): Channel | null => {
  let shared: Uint8Array
  try {
    shared = x25519.getSharedSecret(own.secretKey, hexToBytes(peerNonce))
  } catch {
    return null
  }
  const [serverNonce, clientNonce] = side === "server" ? [own.publicKey, peerNonce] : [peerNonce, own.publicKey]
  const keys = hkdf(
    sha256,
    shared,
    utf8ToBytes(token),
    utf8ToBytes(`hinacode channel\n${serverNonce}\n${clientNonce}`),
    64,
  )
  const toClient = keys.subarray(0, 32)
  const toServer = keys.subarray(32)
  const [sendKey, receiveKey] = side === "server" ? [toClient, toServer] : [toServer, toClient]
  let sent = 0
  let received = 0
  return {
    seal: (text) => chacha20poly1305(sendKey, counterNonce(sent++)).encrypt(utf8ToBytes(text)),
    open: (sealed) => {
      try {
        const text = bytesToUtf8(chacha20poly1305(receiveKey, counterNonce(received)).decrypt(sealed))
        received++
        return text
      } catch {
        return null
      }
    },
  }
}

const decodeServerFrame = Schema.decodeUnknownOption(ServerFrame)

const parseServerFrame = (text: string): ServerFrame | null => {
  try {
    return Option.getOrNull(decodeServerFrame(JSON.parse(text)))
  } catch {
    return null
  }
}

/**
 * What a client does with one message. `reply` is the `auth` text to send. `frame` comes from the machine: the
 * first is its `ready`. `refuse` means whoever answered before `ready` does not hold the token, so the socket closes
 * as unauthorized. `broken` means a frame after `ready` was not the machine's next one, so the socket closes and the
 * client dials again. `ignore` drops a frame this client cannot decode.
 */
export type ClientStep =
  | { readonly type: "reply"; readonly text: string }
  | { readonly type: "frame"; readonly frame: ServerFrame }
  | { readonly type: "refuse" }
  | { readonly type: "broken" }
  | { readonly type: "ignore" }

/** A client's half of one socket: feed it every message, and seal every frame it sends after the machine's `ready`. */
export interface ClientHandshake {
  readonly receive: (message: string | Uint8Array) => ClientStep
  readonly seal: (frame: ClientFrame) => Uint8Array
}

type ClientState =
  | { readonly phase: "challenged" }
  | { readonly phase: "authenticating"; readonly channel: Channel; readonly expectedProof: string }
  | { readonly phase: "sealed"; readonly channel: Channel }
  /** The machine proved the token on a protocol before sealing. Its `ready` only tells the client to stop. */
  | { readonly phase: "outdated" }

export const clientHandshake = (token: string): ClientHandshake => {
  const own = newKeyPair()
  let state: ClientState = { phase: "challenged" }
  const refuse: ClientStep = { type: "refuse" }

  const receivePlain = (text: string): ClientStep => {
    const frame = parseServerFrame(text)
    if (state.phase === "challenged") {
      if (frame?.type !== "challenge") return refuse
      const channel = openChannel("client", token, own, frame.nonce)
      if (channel === null) return refuse
      state = { phase: "authenticating", channel, expectedProof: serverProof(token, own.publicKey, frame.nonce) }
      const auth: ClientFrame = {
        type: "auth",
        nonce: own.publicKey,
        proof: clientProof(token, frame.nonce, own.publicKey),
        sealed: true,
      }
      return { type: "reply", text: JSON.stringify(auth) }
    }
    if (state.phase === "outdated") return { type: "ignore" }
    if (state.phase === "sealed") return { type: "broken" }
    // Only a machine on an older protocol answers in plain text. One on this protocol would seal its `ready`, so a
    // plain one claiming it is someone stripping the encryption.
    const outdated =
      state.phase === "authenticating" &&
      frame?.type === "ready" &&
      frame.proof === state.expectedProof &&
      frame.version < REMOTE_PROTOCOL_VERSION
    if (!outdated) return refuse
    state = { phase: "outdated" }
    return { type: "frame", frame }
  }

  const receiveSealed = (sealed: Uint8Array): ClientStep => {
    if (state.phase !== "authenticating" && state.phase !== "sealed") return refuse
    const text = state.channel.open(sealed)
    if (text === null) return state.phase === "sealed" ? { type: "broken" } : refuse
    const frame = parseServerFrame(text)
    if (state.phase === "sealed") return frame === null ? { type: "ignore" } : { type: "frame", frame }
    if (frame?.type !== "ready" || frame.proof !== state.expectedProof) return refuse
    state = { phase: "sealed", channel: state.channel }
    return { type: "frame", frame }
  }

  return {
    receive: (message) => (typeof message === "string" ? receivePlain(message) : receiveSealed(message)),
    seal: (frame) => {
      if (state.phase !== "sealed") throw new Error("Sealed a frame before the machine's ready")
      return state.channel.seal(JSON.stringify(frame))
    },
  }
}
