import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js"
import { Option, Schema } from "effect"
import {
  approvalCode,
  type Channel,
  commitment,
  initiate,
  type KeyPair,
  newNonce,
  REMOTE_PROLOGUE,
  sameBytes,
} from "./noise.ts"
import { type ClientFrame, ServerFrame } from "./remote.ts"

export type Hello = Omit<Extract<ClientFrame, { type: "hello" }>, "type">

export type Received =
  | { readonly type: "ignored" }
  | { readonly type: "handshaken" }
  | { readonly type: "pending" }
  | { readonly type: "code"; readonly code: string }
  | { readonly type: "frame"; readonly frame: ServerFrame }
  | { readonly type: "refused" }
  | { readonly type: "broken" }

const decodeFrame = Schema.decodeUnknownOption(Schema.fromJsonString(ServerFrame))
const utf8 = new TextDecoder("utf-8", { fatal: true })

const bytesOf = (data: unknown): Uint8Array | null => {
  if (data instanceof Uint8Array) return data
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  return null
}

const openFrame = (channel: Channel, ciphertext: Uint8Array) => {
  try {
    return Option.getOrNull(decodeFrame(utf8.decode(channel.decrypt(ciphertext))))
  } catch {
    return null
  }
}

export const clientSession = (input: {
  readonly hostKey: Uint8Array
  readonly device: KeyPair
  readonly hello: Hello
  readonly send: (data: Uint8Array) => void
}) => {
  const initiator = initiate({
    prologue: REMOTE_PROLOGUE,
    local: input.device,
    remoteStatic: input.hostKey,
    payload: new Uint8Array(0),
  })
  let channel: Channel | null = null
  let approval: { readonly committed: Uint8Array; readonly clientNonce: Uint8Array } | null = null
  let revealed = false

  const send = (frame: ClientFrame) => {
    if (channel === null) throw new Error("No frame can be sent before the handshake")
    input.send(channel.encrypt(utf8ToBytes(JSON.stringify(frame))))
  }

  const finish = (reply: Uint8Array): Received => {
    try {
      channel = initiator.finish(reply).channel
    } catch {
      return { type: "refused" }
    }
    send({ type: "hello", ...input.hello })
    return { type: "handshaken" }
  }

  const reveal = (secured: Channel, serverNonce: Uint8Array): Received => {
    if (approval === null || revealed) return { type: "broken" }
    revealed = true
    if (!sameBytes(commitment(serverNonce), approval.committed)) return { type: "refused" }
    return { type: "code", code: approvalCode(secured.handshakeHash, approval.clientNonce, serverNonce) }
  }

  const receive = (data: unknown): Received => {
    const bytes = bytesOf(data)
    if (bytes === null) return channel === null ? { type: "ignored" } : { type: "broken" }
    if (channel === null) return finish(bytes)
    const frame = openFrame(channel, bytes)
    if (frame === null) return { type: "broken" }
    if (frame.type === "approval") return reveal(channel, hexToBytes(frame.nonce))
    if (frame.type !== "pending") return { type: "frame", frame }
    if (approval !== null) return { type: "broken" }
    approval = { committed: hexToBytes(frame.commitment), clientNonce: newNonce() }
    send({ type: "approval", nonce: bytesToHex(approval.clientNonce) })
    return { type: "pending" }
  }

  return {
    start: () => input.send(initiator.message),
    receive,
    send,
    handshaken: () => channel !== null,
  }
}

export type ClientSession = ReturnType<typeof clientSession>
