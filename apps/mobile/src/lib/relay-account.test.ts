import { describe, expect, it } from "vitest"
import type { RelayMachine } from "@shared/relayMachines.ts"
import { applyRelayMachines, fetchRelayMachines } from "./relay-account"
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

  it("keeps a QR-paired server the list no longer has", () => {
    expect(applyRelayMachines([server()], [], newId)).toEqual([server()])
  })

  it("drops every relay server for an empty list", () => {
    const servers = [
      server({ source: "relay" }),
      server({ id: "b", environmentId: "env-b", relay: "b.relay.example.com", source: "relay" }),
    ]
    expect(applyRelayMachines(servers, [], newId)).toEqual([])
  })
})

const account = { serviceUrl: "https://relay.example.com/", ownerToken: "owner" }

const answering =
  (status: number, body: unknown): typeof fetch =>
  async () =>
    new Response(JSON.stringify(body), { status })

describe("fetchRelayMachines", () => {
  it("lists the machines with the owner token", async () => {
    let asked: { url: string; authorization: string | null } | null = null
    const fetch: typeof globalThis.fetch = async (url, init) => {
      asked = { url: String(url), authorization: new Headers(init?.headers).get("authorization") }
      return new Response(JSON.stringify({ machines: [machine()] }), { status: 200 })
    }
    expect(await fetchRelayMachines(account, fetch)).toEqual({ _tag: "machines", machines: [machine()] })
    expect(asked).toEqual({ url: "https://relay.example.com/v1/machines", authorization: "Bearer owner" })
  })

  it("reports a refused owner token", async () => {
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
