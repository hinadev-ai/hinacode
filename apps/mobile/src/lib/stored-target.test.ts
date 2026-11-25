import { describe, expect, it } from "vitest"
import { encodeKey, generateKeyPair } from "@shared/noise.ts"
import { addPairing, parseStoredServers, type StoredServer } from "./stored-target"

const newId = () => "new"

const KEY = encodeKey(generateKeyPair().publicKey)
const RESET_KEY = encodeKey(generateKeyPair().publicKey)

const server = (overrides: Partial<StoredServer> = {}): StoredServer => ({
  id: "a",
  name: "studio",
  environmentId: "env-a",
  hosts: ["100.64.0.2", "192.168.1.5"],
  port: 47821,
  key: KEY,
  secret: null,
  verified: true,
  relay: null,
  source: "pairing",
  ...overrides,
})

describe("parseStoredServers", () => {
  it("reads every server in order", () => {
    const servers = [
      server({ secret: "one-time" }),
      server({
        id: "b",
        name: null,
        environmentId: null,
        hosts: ["10.0.0.9"],
        relay: "b.example.com",
        verified: false,
        source: "relay",
      }),
    ]
    expect(parseStoredServers(JSON.stringify(servers), null, newId)).toEqual(servers)
  })

  it("reads an entry saved before the relay existed as having none", () => {
    const { relay: _, ...older } = server()
    expect(parseStoredServers(JSON.stringify([older]), null, newId)).toEqual([server()])
  })

  it("reads an entry saved before the relay sync as paired by QR code", () => {
    const { source: _, ...older } = server()
    expect(parseStoredServers(JSON.stringify([older]), null, newId)).toEqual([server()])
  })

  it("reads an entry saved before encryption as a pairing without a key", () => {
    const { key: _, secret: __, verified: ___, ...older } = server()
    expect(parseStoredServers(JSON.stringify([{ ...older, token: "abc" }]), null, newId)).toEqual([
      server({ key: null, verified: false }),
    ])
  })

  it("drops a bad entry and keeps the rest", () => {
    const raw = JSON.stringify([
      server({ hosts: ["bad/path"] }),
      server({ id: "b", port: 0 }),
      server({ id: "c", key: "not-a-key" }),
      server({ id: "d" }),
    ])
    expect(parseStoredServers(raw, null, newId).map((entry) => entry.id)).toEqual(["d"])
  })

  it("turns the single pairing an older app saved into a server that must pair again", () => {
    const legacy = JSON.stringify({ hosts: ["100.64.0.2"], port: 47821, token: "abc" })
    expect(parseStoredServers(null, legacy, newId)).toEqual([
      {
        id: "new",
        name: null,
        environmentId: null,
        hosts: ["100.64.0.2"],
        port: 47821,
        key: null,
        secret: null,
        verified: false,
        relay: null,
        source: "pairing",
      },
    ])
  })

  it("migrates a single-host pairing from before multi-host pairing", () => {
    const legacy = JSON.stringify({ host: "192.168.1.5", port: 47821, token: "abc" })
    expect(parseStoredServers(null, legacy, newId)[0]?.hosts).toEqual(["192.168.1.5"])
  })

  it("prefers the list once it exists", () => {
    const legacy = JSON.stringify({ hosts: ["10.0.0.1"], port: 1, token: "old" })
    expect(parseStoredServers("[]", legacy, newId)).toEqual([])
  })

  it.each([
    [null, null],
    ["not json", null],
    [null, "not json"],
    [null, JSON.stringify({ hosts: [], port: 47821, token: "abc" })],
    [null, JSON.stringify({ hosts: ["localhost"], port: 65536, token: "abc" })],
  ])("reads %s and %s as no servers", (raw, legacy) => {
    expect(parseStoredServers(raw, legacy, newId)).toEqual([])
  })
})

const pairing = (hosts: [string, ...string[]], port: number, key = KEY, relay: string | null = null) => ({
  hosts,
  port,
  relay,
  key,
  secret: "one-time",
})

describe("addPairing", () => {
  it("adds a server it has not seen with its pinned key and secret", () => {
    const { servers, id } = addPairing([server()], pairing(["10.0.0.9"], 47821, RESET_KEY), newId)
    expect(id).toBe("new")
    expect(servers.map((entry) => entry.id)).toEqual(["a", "new"])
    expect(servers[1]).toMatchObject({ source: "pairing", key: RESET_KEY, secret: "one-time", verified: true })
  })

  it("keeps the source of a relay server paired again by QR code", () => {
    const { servers } = addPairing(
      [server({ source: "relay", verified: false })],
      pairing(["192.168.1.5"], 47821, RESET_KEY),
      newId,
    )
    expect(servers[0]).toMatchObject({ source: "relay", key: RESET_KEY, verified: true })
  })

  it("pins the new key of a server paired again at an address it had", () => {
    const { servers, id } = addPairing([server()], pairing(["192.168.1.5"], 47821, RESET_KEY), newId)
    expect(id).toBe("a")
    expect(servers).toEqual([server({ hosts: ["192.168.1.5"], key: RESET_KEY, secret: "one-time" })])
  })

  it("keeps a server on another port apart", () => {
    const { servers } = addPairing([server()], pairing(["192.168.1.5"], 47822), newId)
    expect(servers).toHaveLength(2)
  })
  it("updates the server with the same relay when it is paired again at new addresses", () => {
    const target = pairing(["10.0.0.9"], 48081, RESET_KEY, "studio.example.com")
    const { servers, id } = addPairing([server({ relay: target.relay })], target, newId)
    expect(id).toBe("a")
    expect(servers).toEqual([server(target)])
  })
})
