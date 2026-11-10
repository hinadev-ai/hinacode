import { createHash } from "node:crypto"
import { Option } from "effect"
import { describe, expect, it } from "vitest"
import {
  checkAuthorization,
  clientOf,
  isRedirectUri,
  readClient,
  redirectAllowed,
  redirectTo,
  signClient,
  verifierMatches,
} from "./oauth.ts"

const key = Buffer.alloc(32, 1)
const otherKey = Buffer.alloc(32, 2)
const issuer = "https://desk.relay.example"
const client = { name: "Chat app", redirectUris: ["https://chat.example/callback"] as const }
const verifier = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~"
const challenge = createHash("sha256").update(verifier).digest("base64url")

describe("redirect URIs", () => {
  it("takes https anywhere and http only on loopback", () => {
    expect(isRedirectUri("https://chat.example/callback")).toBe(true)
    expect(isRedirectUri("http://localhost:3000/callback")).toBe(true)
    expect(isRedirectUri("http://127.0.0.1/callback")).toBe(true)
    expect(isRedirectUri("http://[::1]:8080/callback")).toBe(true)
    expect(isRedirectUri("http://chat.example/callback")).toBe(false)
    expect(isRedirectUri("http://localhost.evil.example/callback")).toBe(false)
    expect(isRedirectUri("https://chat.example/callback#fragment")).toBe(false)
    expect(isRedirectUri("javascript:alert(1)")).toBe(false)
    expect(isRedirectUri("myapp://callback")).toBe(false)
    expect(isRedirectUri("not a url")).toBe(false)
  })

  it("matches a registered URI exactly, except a loopback port", () => {
    const registered = ["https://chat.example/callback", "http://127.0.0.1:1234/callback"]
    expect(redirectAllowed(registered, "https://chat.example/callback")).toBe(true)
    expect(redirectAllowed(registered, "https://chat.example/callback/")).toBe(false)
    expect(redirectAllowed(registered, "https://chat.example/callback?next=1")).toBe(false)
    expect(redirectAllowed(registered, "https://chat.example:8443/callback")).toBe(false)
    expect(redirectAllowed(registered, "http://127.0.0.1:5678/callback")).toBe(true)
    expect(redirectAllowed(registered, "http://127.0.0.1/callback")).toBe(true)
    expect(redirectAllowed(registered, "http://127.0.0.1:5678/elsewhere")).toBe(false)
    expect(redirectAllowed(registered, "http://localhost:5678/callback")).toBe(false)
  })

  it("adds the answer to the query the redirect URI already has", () => {
    expect(redirectTo("https://chat.example/callback?tenant=1", { code: "a b", state: undefined })).toBe(
      "https://chat.example/callback?tenant=1&code=a+b",
    )
  })
})

describe("client ids", () => {
  it("reads back the client it signed", () => {
    expect(readClient(key, signClient(key, client))).toEqual(Option.some(client))
  })

  it("refuses an id that was changed or signed with another key", () => {
    const clientId = signClient(key, client)
    const [payload, signature] = clientId.split(".") as [string, string]
    const forged = Buffer.from(JSON.stringify({ ...client, redirectUris: ["https://evil.example/callback"] })).toString(
      "base64url",
    )
    expect(readClient(key, `${forged}.${signature}`)).toEqual(Option.none())
    expect(readClient(key, payload)).toEqual(Option.none())
    expect(readClient(key, `${clientId}.extra`)).toEqual(Option.none())
    expect(readClient(key, "")).toEqual(Option.none())
    expect(readClient(otherKey, clientId)).toEqual(Option.none())
  })

  it("names a client after its redirect host when it gives no name", () => {
    expect(clientOf({ redirect_uris: ["https://chat.example/callback"] })).toEqual(
      Option.some({ name: "chat.example", redirectUris: ["https://chat.example/callback"] }),
    )
    expect(clientOf({ client_name: "  ", redirect_uris: ["http://localhost:3000/cb"] })).toEqual(
      Option.some({ name: "localhost:3000", redirectUris: ["http://localhost:3000/cb"] }),
    )
  })

  it("bounds the name and the redirect URIs", () => {
    const uri = "https://chat.example/callback"
    expect(Option.isSome(clientOf({ client_name: "n".repeat(100), redirect_uris: Array(5).fill(uri) }))).toBe(true)
    expect(clientOf({ client_name: "n".repeat(101), redirect_uris: [uri] })).toEqual(Option.none())
    expect(clientOf({ redirect_uris: Array(6).fill(uri) })).toEqual(Option.none())
    expect(clientOf({ redirect_uris: [`${uri}?${"q".repeat(512)}`] })).toEqual(Option.none())
    expect(clientOf({ redirect_uris: [] })).toEqual(Option.none())
    expect(clientOf({ redirect_uris: ["http://chat.example/callback"] })).toEqual(Option.none())
  })
})

describe("authorization requests", () => {
  const params = {
    response_type: "code",
    client_id: signClient(key, client),
    redirect_uri: "https://chat.example/callback",
    code_challenge: challenge,
    code_challenge_method: "S256",
  }

  const refusal = (changed: Partial<typeof params> & { resource?: string }) => {
    const check = checkAuthorization(key, issuer, { ...params, ...changed })
    return !check.ok && check.redirect ? check.error : null
  }

  it("accepts a registered client with an S256 challenge", () => {
    expect(checkAuthorization(key, issuer, params)).toEqual({ ok: true, client, codeChallenge: challenge })
    expect(checkAuthorization(key, issuer, { ...params, resource: `${issuer}/mcp` }).ok).toBe(true)
  })

  it("never redirects for an unknown client or redirect URI", () => {
    const unknown = { ok: false, redirect: false }
    expect(checkAuthorization(otherKey, issuer, params)).toEqual(unknown)
    expect(checkAuthorization(key, issuer, { ...params, redirect_uri: "https://evil.example/callback" })).toEqual(
      unknown,
    )
  })

  it("redirects the other refusals back to the client", () => {
    expect(refusal({ response_type: "token" })).toBe("unsupported_response_type")
    expect(refusal({ code_challenge_method: "plain" })).toBe("invalid_request")
    expect(refusal({ code_challenge: "short" })).toBe("invalid_request")
    expect(refusal({ resource: "https://elsewhere.example/mcp" })).toBe("invalid_target")
  })

  it("matches a verifier only against its own challenge", () => {
    expect(verifierMatches(verifier, challenge)).toBe(true)
    expect(verifierMatches(`${verifier}x`, challenge)).toBe(false)
    expect(verifierMatches(verifier, "short")).toBe(false)
  })
})
