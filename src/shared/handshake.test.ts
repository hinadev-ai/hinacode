import { createHmac } from "node:crypto"
import { describe, expect, it } from "vitest"
import { type ClientStep, clientHandshake, clientProof, newKeyPair, openChannel, serverProof } from "./handshake.ts"
import { REMOTE_PROTOCOL_VERSION, type ServerFrame } from "./remote.ts"

const hmac = (key: string, message: string) => createHmac("sha256", key).update(message).digest("hex")

/** The machine's half, as `server.ts` runs it. */
const machine = (token: string) => {
  const keys = newKeyPair()
  return {
    challenge: JSON.stringify({ type: "challenge", nonce: keys.publicKey } satisfies ServerFrame),
    accept: (auth: string) => {
      const frame = JSON.parse(auth) as { nonce: string; proof: string; sealed?: true }
      const channel = openChannel("server", token, keys, frame.nonce)!
      const proof = serverProof(token, frame.nonce, keys.publicKey)
      return { frame, channel, proof, ready: channel.seal(JSON.stringify(ready(proof))) }
    },
  }
}

const ready = (proof: string, version = REMOTE_PROTOCOL_VERSION): ServerFrame => ({ type: "ready", version, proof })

const replyText = (step: ClientStep) => {
  if (step.type !== "reply") throw new Error(`expected a reply, got ${step.type}`)
  return step.text
}

const pair = (serverToken: string, clientToken: string) => {
  const server = newKeyPair()
  const client = newKeyPair()
  return {
    server: openChannel("server", serverToken, server, client.publicKey)!,
    client: openChannel("client", clientToken, client, server.publicKey)!,
  }
}

describe("token proofs", () => {
  it("are HMAC-SHA256 of both nonces, keyed by the token", () => {
    expect(clientProof("token", "server-nonce", "client-nonce")).toBe(
      hmac("token", "hinacode client\nserver-nonce\nclient-nonce"),
    )
    expect(serverProof("token", "client-nonce", "server-nonce")).toBe(
      hmac("token", "hinacode server\nclient-nonce\nserver-nonce"),
    )
  })

  it("differ by side, so a client proof never passes as the server's", () => {
    expect(clientProof("token", "a", "b")).not.toBe(serverProof("token", "a", "b"))
  })
})

describe("channels", () => {
  it("carry text both ways, and the bytes on the wire are not the text", () => {
    const { server, client } = pair("token", "token")
    const sealed = server.seal('{"type":"event","secret":"hunter2"}')
    expect(Buffer.from(sealed).toString("latin1")).not.toContain("hunter2")
    expect(client.open(sealed)).toBe('{"type":"event","secret":"hunter2"}')
    expect(server.open(client.seal("ping"))).toBe("ping")
  })

  it("refuse a frame sealed with another token", () => {
    const { server, client } = pair("token", "other")
    expect(client.open(server.seal("hello"))).toBeNull()
  })

  it("refuse a frame replayed, dropped or tampered with", () => {
    const { server, client } = pair("token", "token")
    const first = server.seal("one")
    expect(client.open(first)).toBe("one")
    expect(client.open(first)).toBeNull()

    const { server: s2, client: c2 } = pair("token", "token")
    s2.seal("dropped")
    expect(c2.open(s2.seal("two"))).toBeNull()

    const { server: s3, client: c3 } = pair("token", "token")
    const tampered = s3.seal("three")
    tampered[0]! ^= 1
    expect(c3.open(tampered)).toBeNull()
  })

  it("refuse a nonce that is not an X25519 key", () => {
    expect(openChannel("server", "token", newKeyPair(), "not hex")).toBeNull()
    expect(openChannel("server", "token", newKeyPair(), "00".repeat(32))).toBeNull()
  })

  it("use fresh keys on every socket", () => {
    expect(newKeyPair().publicKey).toMatch(/^[0-9a-f]{64}$/)
    expect(newKeyPair().publicKey).not.toBe(newKeyPair().publicKey)
  })
})

describe("a client's handshake", () => {
  it("answers the challenge with a sealed auth and a proof, never the token", () => {
    const server = machine("token")
    const auth = replyText(clientHandshake("token").receive(server.challenge))
    expect(auth).not.toContain("token")
    const { frame } = server.accept(auth)
    expect(frame.sealed).toBe(true)
    expect(frame.proof).toBe(clientProof("token", JSON.parse(server.challenge).nonce, frame.nonce))
  })

  it("opens the machine's sealed ready and seals every frame after it", () => {
    const server = machine("token")
    const client = clientHandshake("token")
    const { channel, proof, ready: sealedReady } = server.accept(replyText(client.receive(server.challenge)))
    expect(() => client.seal({ type: "hub" })).toThrow()
    expect(client.receive(sealedReady)).toStrictEqual({ type: "frame", frame: ready(proof) })
    expect(channel.open(client.seal({ type: "hub" }))).toBe('{"type":"hub"}')
    const event = channel.seal(JSON.stringify({ type: "pong", at: 1 }))
    expect(client.receive(event)).toStrictEqual({ type: "frame", frame: { type: "pong", at: 1 } })
  })

  it("refuses whoever answers without the token", () => {
    const stranger = machine("someone else's")
    const client = clientHandshake("token")
    const { ready: sealedReady } = stranger.accept(replyText(client.receive(stranger.challenge)))
    expect(client.receive(sealedReady).type).toBe("refuse")
  })

  it("refuses a socket that skips the challenge, or speaks plain text after it on this protocol", () => {
    const server = machine("token")
    expect(clientHandshake("token").receive(JSON.stringify(ready("x"))).type).toBe("refuse")
    const client = clientHandshake("token")
    const { proof } = server.accept(replyText(client.receive(server.challenge)))
    expect(client.receive(JSON.stringify(ready(proof))).type).toBe("refuse")
  })

  it("hears an older machine's version in plain text when it proves the token, and nothing after", () => {
    const server = machine("token")
    const client = clientHandshake("token")
    const { proof } = server.accept(replyText(client.receive(server.challenge)))
    const older = ready(proof, REMOTE_PROTOCOL_VERSION - 1)
    expect(client.receive(JSON.stringify(older))).toStrictEqual({ type: "frame", frame: older })
    expect(client.receive(JSON.stringify({ type: "pong", at: 1 })).type).toBe("ignore")
  })

  it("calls the link broken when a frame after ready does not open", () => {
    const server = machine("token")
    const client = clientHandshake("token")
    const { channel, ready: sealedReady } = server.accept(replyText(client.receive(server.challenge)))
    client.receive(sealedReady)
    channel.seal("skipped")
    expect(client.receive(channel.seal("next")).type).toBe("broken")
    expect(client.receive(JSON.stringify({ type: "pong", at: 1 })).type).toBe("broken")
  })
})
