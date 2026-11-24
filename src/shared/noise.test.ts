import { sha256 } from "@noble/hashes/sha2.js"
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js"
import { describe, expect, test } from "vitest"
import {
  approvalCode,
  type Channel,
  commitment,
  decodeKey,
  encodeKey,
  generateKeyPair,
  initiate,
  keyPairFromSecret,
  newNonce,
  REMOTE_PROLOGUE,
  respond,
  sameBytes,
} from "./noise.ts"
import vectors from "./noise.vectors.json" with { type: "json" }
import { REMOTE_MAX_FRAME_BYTES } from "./remote.ts"

type Vector = (typeof vectors)[number]

const runVector = (vector: Vector) => {
  const prologue = hexToBytes(vector.prologue)
  const initiatorStatic = keyPairFromSecret(hexToBytes(vector.initiatorStatic))
  const responderStatic = keyPairFromSecret(hexToBytes(vector.responderStatic))
  const [first, second, ...transport] = vector.messages
  if (!first || !second) throw new Error(`The ${vector.source} vector has no handshake`)
  const initiator = initiate({
    prologue,
    local: initiatorStatic,
    remoteStatic: responderStatic.publicKey,
    payload: hexToBytes(first.payload),
    ephemeral: keyPairFromSecret(hexToBytes(vector.initiatorEphemeral)),
  })
  const responder = respond({
    prologue,
    local: responderStatic,
    message: initiator.message,
    ephemeral: keyPairFromSecret(hexToBytes(vector.responderEphemeral)),
  })
  const reply = responder.reply(hexToBytes(second.payload))
  const finished = initiator.finish(reply.message)
  return { first, second, transport, initiatorStatic, responderStatic, initiator, responder, reply, finished }
}

const connect = () => {
  const host = generateKeyPair()
  const device = generateKeyPair()
  const initiator = initiate({
    prologue: REMOTE_PROLOGUE,
    local: device,
    remoteStatic: host.publicKey,
    payload: utf8ToBytes('{"name":"phone"}'),
  })
  const responder = respond({ prologue: REMOTE_PROLOGUE, local: host, message: initiator.message })
  const reply = responder.reply(utf8ToBytes('{"type":"ready"}'))
  const finished = initiator.finish(reply.message)
  return { host, device, responder, reply, finished, client: finished.channel, server: reply.channel }
}

const frame = (text: string) => utf8ToBytes(text)

const flipBit = (bytes: Uint8Array, target: number) => bytes.map((byte, index) => (index === target ? byte ^ 1 : byte))

const decryptsTo = (channel: Channel, ciphertext: Uint8Array, text: string) =>
  expect(new TextDecoder().decode(channel.decrypt(ciphertext))).toBe(text)

describe("Noise_IK_25519_ChaChaPoly_SHA256 test vectors", () => {
  test.each(vectors)("matches every message of the $source vector", (vector) => {
    const { first, second, transport, initiatorStatic, responderStatic, initiator, responder, reply, finished } =
      runVector(vector)

    expect(bytesToHex(responderStatic.publicKey)).toBe(vector.responderStaticPublic)
    expect(bytesToHex(initiator.message)).toBe(first.ciphertext)
    expect(bytesToHex(responder.payload)).toBe(first.payload)
    expect(responder.remoteStatic).toEqual(initiatorStatic.publicKey)
    expect(bytesToHex(reply.message)).toBe(second.ciphertext)
    expect(bytesToHex(finished.payload)).toBe(second.payload)

    transport.forEach((message, index) => {
      const [sender, receiver] = index % 2 === 0 ? [finished.channel, reply.channel] : [reply.channel, finished.channel]
      const ciphertext = sender.encrypt(hexToBytes(message.payload))
      expect(bytesToHex(ciphertext)).toBe(message.ciphertext)
      expect(bytesToHex(receiver.decrypt(ciphertext))).toBe(message.payload)
    })
  })

  test.each(vectors.filter((vector) => "handshakeHash" in vector))(
    "matches the handshake hash of the $source vector",
    (vector) => {
      const { reply, finished } = runVector(vector)
      expect(bytesToHex(finished.channel.handshakeHash)).toBe(vector.handshakeHash)
      expect(bytesToHex(reply.channel.handshakeHash)).toBe(vector.handshakeHash)
    },
  )
})

describe("handshake", () => {
  test("delivers both payloads and the device key, and both sides derive the same hash and code", () => {
    const { device, responder, finished, client, server } = connect()

    expect(new TextDecoder().decode(responder.payload)).toBe('{"name":"phone"}')
    expect(new TextDecoder().decode(finished.payload)).toBe('{"type":"ready"}')
    expect(responder.remoteStatic).toEqual(device.publicKey)
    expect(client.handshakeHash).toEqual(server.handshakeHash)
    const [clientNonce, serverNonce] = [newNonce(), newNonce()]
    expect(approvalCode(client.handshakeHash, clientNonce, serverNonce)).toBe(
      approvalCode(server.handshakeHash, clientNonce, serverNonce),
    )

    decryptsTo(server, client.encrypt(frame("call")), "call")
    decryptsTo(client, server.encrypt(frame("result")), "result")
    decryptsTo(server, client.encrypt(frame("second call")), "second call")
  })

  test("a client that pinned the wrong host key cannot reach the host", () => {
    const host = generateKeyPair()
    const initiator = initiate({
      prologue: REMOTE_PROLOGUE,
      local: generateKeyPair(),
      remoteStatic: generateKeyPair().publicKey,
      payload: frame("{}"),
    })
    expect(() => respond({ prologue: REMOTE_PROLOGUE, local: host, message: initiator.message })).toThrow()
  })

  test("a different prologue fails the handshake", () => {
    const host = generateKeyPair()
    const initiator = initiate({
      prologue: utf8ToBytes("hinacode remote 1"),
      local: generateKeyPair(),
      remoteStatic: host.publicKey,
      payload: frame("{}"),
    })
    expect(() => respond({ prologue: REMOTE_PROLOGUE, local: host, message: initiator.message })).toThrow()
  })

  test("a low-order ephemeral key is rejected", () => {
    const host = generateKeyPair()
    const { message } = initiate({
      prologue: REMOTE_PROLOGUE,
      local: generateKeyPair(),
      remoteStatic: host.publicKey,
      payload: frame("{}"),
    })
    message.fill(0, 0, 32)
    expect(() => respond({ prologue: REMOTE_PROLOGUE, local: host, message })).toThrow()
  })

  test("a host key that is not 32 bytes is refused", () => {
    expect(() =>
      initiate({
        prologue: REMOTE_PROLOGUE,
        local: generateKeyPair(),
        remoteStatic: new Uint8Array(31),
        payload: frame("{}"),
      }),
    ).toThrow()
  })

  test("a flipped bit in message 2 makes the client refuse it", () => {
    const host = generateKeyPair()
    const initiator = initiate({
      prologue: REMOTE_PROLOGUE,
      local: generateKeyPair(),
      remoteStatic: host.publicKey,
      payload: frame("{}"),
    })
    const { message } = respond({ prologue: REMOTE_PROLOGUE, local: host, message: initiator.message }).reply(
      frame("{}"),
    )
    expect(() => initiator.finish(flipBit(message, message.length - 1))).toThrow()
  })

  test("a handshake message over 65535 bytes is refused", () => {
    expect(() =>
      initiate({
        prologue: REMOTE_PROLOGUE,
        local: generateKeyPair(),
        remoteStatic: generateKeyPair().publicKey,
        payload: new Uint8Array(65535),
      }),
    ).toThrow()
  })

  test("each handshake step runs once", () => {
    const host = generateKeyPair()
    const initiator = initiate({
      prologue: REMOTE_PROLOGUE,
      local: generateKeyPair(),
      remoteStatic: host.publicKey,
      payload: frame("{}"),
    })
    const responder = respond({ prologue: REMOTE_PROLOGUE, local: host, message: initiator.message })
    const { message } = responder.reply(frame("{}"))
    expect(() => responder.reply(frame("{}"))).toThrow()
    initiator.finish(message)
    expect(() => initiator.finish(message)).toThrow()
  })
})

describe("channel", () => {
  test("a tampered frame is refused, and the channel stays closed after it", () => {
    const { client, server } = connect()
    const ciphertext = client.encrypt(frame("call"))
    expect(() => server.decrypt(flipBit(ciphertext, 0))).toThrow()
    expect(() => server.decrypt(ciphertext)).toThrow()
  })

  test("a replayed frame is refused", () => {
    const { client, server } = connect()
    const ciphertext = client.encrypt(frame("call"))
    decryptsTo(server, ciphertext, "call")
    expect(() => server.decrypt(ciphertext)).toThrow()
  })

  test("a reordered frame is refused", () => {
    const { client, server } = connect()
    client.encrypt(frame("first"))
    const second = client.encrypt(frame("second"))
    expect(() => server.decrypt(second)).toThrow()
  })

  test("a frame from the other direction is refused", () => {
    const { client, server } = connect()
    const ciphertext = client.encrypt(frame("call"))
    expect(() => client.decrypt(ciphertext)).toThrow()
    decryptsTo(server, ciphertext, "call")
  })

  test("a 16 MiB frame round-trips", () => {
    const { client, server } = connect()
    const plaintext = new Uint8Array(REMOTE_MAX_FRAME_BYTES).map((_, index) => index % 251)
    expect(bytesToHex(sha256(server.decrypt(client.encrypt(plaintext))))).toBe(bytesToHex(sha256(plaintext)))
  })
})

describe("approvalCode", () => {
  test("is six Crockford base32 characters, the same for the same inputs", () => {
    const { client } = connect()
    const [clientNonce, serverNonce] = [newNonce(), newNonce()]
    const code = approvalCode(client.handshakeHash, clientNonce, serverNonce)
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{3}-[0-9A-HJKMNP-TV-Z]{3}$/)
    expect(approvalCode(client.handshakeHash.slice(), clientNonce.slice(), serverNonce.slice())).toBe(code)
  })

  test("changes when either nonce changes", () => {
    const handshakeHash = new Uint8Array(32)
    const code = approvalCode(handshakeHash, new Uint8Array(32).fill(1), new Uint8Array(32).fill(2))
    expect(approvalCode(handshakeHash, new Uint8Array(32).fill(3), new Uint8Array(32).fill(2))).not.toBe(code)
    expect(approvalCode(handshakeHash, new Uint8Array(32).fill(1), new Uint8Array(32).fill(3))).not.toBe(code)
  })

  test("encodes the first 30 bits of SHA-256 of the hash and both nonces", () => {
    expect(approvalCode(new Uint8Array(32), new Uint8Array(32).fill(1), new Uint8Array(32).fill(2))).toBe("JD6-HVF")
  })
})

describe("commitment", () => {
  test("binds the server to its nonce before the client reveals one", () => {
    const nonce = newNonce()
    expect(nonce).toHaveLength(32)
    expect(sameBytes(commitment(nonce), commitment(nonce.slice()))).toBe(true)
    expect(sameBytes(commitment(newNonce()), commitment(nonce))).toBe(false)
  })
})

describe("encodeKey and decodeKey", () => {
  test("round-trip a 32-byte key as unpadded base64url", () => {
    const { publicKey } = generateKeyPair()
    const text = encodeKey(publicKey)
    expect(text).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(decodeKey(text)).toEqual(publicKey)
  })

  test.each([
    ["a short key", encodeKey(new Uint8Array(31))],
    ["a long key", encodeKey(new Uint8Array(33))],
    ["padding", `${encodeKey(new Uint8Array(32))}=`],
    ["standard base64 characters", `+${encodeKey(new Uint8Array(32)).slice(1)}`],
    ["unused trailing bits", `${encodeKey(new Uint8Array(32)).slice(0, 42)}B`],
    ["a line break", `${encodeKey(new Uint8Array(32)).slice(0, 20)}\n${encodeKey(new Uint8Array(32)).slice(20)}`],
    ["an empty string", ""],
  ])("refuses %s", (_, text) => {
    expect(decodeKey(text)).toBeNull()
  })
})
