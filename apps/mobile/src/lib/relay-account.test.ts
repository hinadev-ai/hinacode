import { describe, expect, it } from "vitest"
import type { RelayMachine } from "@shared/relayMachines.ts"
import { copy } from "@/lib/copy"
import {
  applyRelayMachines,
  codeFromCallback,
  exchangeSignInCode,
  fetchRelayMachines,
  pkcePair,
  signInUrl,
} from "./relay-account"
import type { StoredServer } from "./stored-target"

const newId = () => "new"

const server = (overrides: Partial<StoredServer> = {}): StoredServer => ({
  id: "a",
  name: "studio",
  environmentId: "env-a",
  hosts: ["192.168.1.5"],
  port: 47821,
  token: "abc",
  relay: "studio.relay.example.com",
  source: "pairing",
  ...overrides,
})

const machine = (overrides: Partial<RelayMachine> = {}): RelayMachine => ({
  environmentId: "env-a",
  name: "Studio",
  pairing: { hosts: ["100.64.0.2"], port: 47822, token: "rotated", relay: "studio.relay.example.com" },
  ...overrides,
})

describe("applyRelayMachines", () => {
  it("adds a machine it has not seen as a relay server", () => {
    expect(applyRelayMachines([], [machine()], newId)).toEqual([
      {
        id: "new",
        name: "Studio",
        environmentId: "env-a",
        hosts: ["100.64.0.2"],
        port: 47822,
        token: "rotated",
        relay: "studio.relay.example.com",
        source: "relay",
      },
    ])
  })

  it("refreshes a QR-paired server's pairing by environment id and keeps its name and source", () => {
    const paired = server({ relay: null })
    expect(applyRelayMachines([paired], [machine()], newId)).toEqual([
      server({ hosts: ["100.64.0.2"], port: 47822, token: "rotated" }),
    ])
  })

  it("renames a relay server the owner renamed", () => {
    const [refreshed] = applyRelayMachines([server({ source: "relay" })], [machine({ name: "Renamed" })], newId)
    expect(refreshed).toMatchObject({ id: "a", name: "Renamed", source: "relay" })
  })

  it("matches by relay hostname when the server's environment id is unknown", () => {
    const [refreshed, ...rest] = applyRelayMachines([server({ environmentId: null })], [machine()], newId)
    expect(rest).toEqual([])
    expect(refreshed).toMatchObject({ id: "a", environmentId: "env-a", token: "rotated", source: "pairing" })
  })

  it("drops a relay server the list no longer has", () => {
    const servers = [server({ source: "relay" }), server({ id: "b", environmentId: "env-b", relay: null })]
    expect(applyRelayMachines(servers, [], newId).map((entry) => entry.id)).toEqual(["b"])
  })
})

const account = { serviceUrl: "https://relay.example.com/", credential: "device" }

const answering =
  (status: number, body: unknown): typeof fetch =>
  async () =>
    new Response(JSON.stringify(body), { status })

describe("fetchRelayMachines", () => {
  it("lists the machines with the credential", async () => {
    let asked: { url: string; authorization: string | null } | null = null
    const fetch: typeof globalThis.fetch = async (url, init) => {
      asked = { url: String(url), authorization: new Headers(init?.headers).get("authorization") }
      return new Response(JSON.stringify({ machines: [machine()] }), { status: 200 })
    }
    expect(await fetchRelayMachines(account, fetch)).toEqual({ _tag: "machines", machines: [machine()] })
    expect(asked).toEqual({ url: "https://relay.example.com/v1/machines", authorization: "Bearer device" })
  })

  it("reports a refused credential", async () => {
    expect(await fetchRelayMachines(account, answering(401, { error: "unauthorized" }))).toEqual({
      _tag: "unauthorized",
    })
  })

  it.each([
    ["an answer of the wrong shape", answering(200, { machines: [{ name: "studio" }] })],
    ["a server error", answering(500, {})],
    [
      "an unreachable relay",
      async () => {
        throw new TypeError("Network request failed")
      },
    ],
  ])("fails with a sentence for %s", async (_, fetch) => {
    const result = await fetchRelayMachines(account, fetch)
    expect(result._tag).toBe("failed")
    expect(result._tag === "failed" && result.message).not.toBe("")
  })
})

describe("pkcePair", () => {
  it("matches the S256 example in RFC 7636 appendix B", () => {
    const random = new Uint8Array([
      116, 24, 223, 180, 151, 153, 224, 37, 79, 250, 96, 125, 216, 173, 187, 186, 22, 212, 37, 77, 105, 214, 191, 240,
      91, 88, 5, 88, 83, 132, 141, 121,
    ])
    expect(pkcePair(random)).toEqual({
      verifier: "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk",
      challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    })
  })
})

describe("signInUrl", () => {
  it("opens the relay's sign-in page with the redirect, challenge and device name", () => {
    const url = new URL(
      signInUrl("https://relay.example.com/", { redirectUri: "hinacode://signed-in", challenge: "abc", name: "My iPhone" }),
    )
    expect(url.origin + url.pathname).toBe("https://relay.example.com/sign-in")
    expect(Object.fromEntries(url.searchParams)).toEqual({
      redirect_uri: "hinacode://signed-in",
      code_challenge: "abc",
      name: "My iPhone",
    })
  })
})

describe("codeFromCallback", () => {
  it("reads the code from the sign-in redirect", () => {
    expect(codeFromCallback("hinacode://signed-in?code=abc123")).toBe("abc123")
  })

  it.each([
    "hinacode://signed-in",
    "hinacode://pair?code=abc123",
    "https://signed-in?code=abc123",
    "not a url",
  ])("finds no code in %s", (url) => {
    expect(codeFromCallback(url)).toBeNull()
  })
})

describe("exchangeSignInCode", () => {
  it("redeems the code with its verifier for a credential", async () => {
    let asked: { url: string; body: unknown } | null = null
    const fetch: typeof globalThis.fetch = async (url, init) => {
      asked = { url: String(url), body: JSON.parse(String(init?.body)) }
      return new Response(JSON.stringify({ credential: "device" }), { status: 200 })
    }
    expect(await exchangeSignInCode("https://relay.example.com/", "code", "verifier", fetch)).toEqual({
      _tag: "signedIn",
      credential: "device",
    })
    expect(asked).toEqual({
      url: "https://relay.example.com/v1/sign-in-codes/exchange",
      body: { code: "code", codeVerifier: "verifier" },
    })
  })

  it.each([
    ["a spent or expired code", answering(410, { error: "gone" }), "mobile_relay_sign_in_expired"],
    ["an answer of the wrong shape", answering(200, { token: "device" }), "mobile_relay_bad_answer"],
    ["a server error", answering(500, {}), "mobile_relay_bad_status"],
    [
      "an unreachable relay",
      async () => {
        throw new TypeError("Network request failed")
      },
      "mobile_relay_unreachable",
    ],
  ] as const)("fails with a sentence for %s", async (_, fetch, key) => {
    expect(await exchangeSignInCode("https://relay.example.com", "code", "verifier", fetch)).toEqual({
      _tag: "failed",
      message: copy(key, { status: "500" }),
    })
  })
})
