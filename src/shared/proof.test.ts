import { createHmac } from "node:crypto"
import { describe, expect, it } from "vitest"
import { clientProof, newNonce, serverProof } from "./proof.ts"

const hmac = (key: string, message: string) => createHmac("sha256", key).update(message).digest("hex")

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

  it("change with the token and with each nonce", () => {
    const proof = clientProof("token", "s", "c")
    expect(clientProof("other", "s", "c")).not.toBe(proof)
    expect(clientProof("token", "s2", "c")).not.toBe(proof)
    expect(clientProof("token", "s", "c2")).not.toBe(proof)
  })

  it("makes fresh 32-byte nonces", () => {
    const nonce = newNonce()
    expect(nonce).toMatch(/^[0-9a-f]{64}$/)
    expect(newNonce()).not.toBe(nonce)
  })
})
