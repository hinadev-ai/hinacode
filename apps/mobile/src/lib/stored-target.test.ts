import { describe, expect, it } from "vitest"
import { addPairing, parseStoredServers, type StoredServer } from "./stored-target"

const newId = () => "new"

const server = (overrides: Partial<StoredServer> = {}): StoredServer => ({
  id: "a",
  name: "studio",
  environmentId: "env-a",
  hosts: ["100.64.0.2", "192.168.1.5"],
  port: 47821,
  token: "abc",
  ...overrides,
})

describe("parseStoredServers", () => {
  it("reads every server in order", () => {
    const servers = [server(), server({ id: "b", name: null, environmentId: null, hosts: ["10.0.0.9"] })]
    expect(parseStoredServers(JSON.stringify(servers), null, newId)).toEqual(servers)
  })

  it("drops a bad entry and keeps the rest", () => {
    const raw = JSON.stringify([server({ hosts: ["bad/path"] }), server({ id: "b", port: 0 }), server({ id: "c" })])
    expect(parseStoredServers(raw, null, newId).map((entry) => entry.id)).toEqual(["c"])
  })

  it("turns the single pairing an older app saved into the first server", () => {
    const legacy = JSON.stringify({ hosts: ["100.64.0.2"], port: 47821, token: "abc" })
    expect(parseStoredServers(null, legacy, newId)).toEqual([
      { id: "new", name: null, environmentId: null, hosts: ["100.64.0.2"], port: 47821, token: "abc" },
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
    [null, JSON.stringify({ host: "localhost", port: 47821, token: "" })],
    [null, JSON.stringify({ hosts: ["localhost"], port: 65536, token: "abc" })],
  ])("reads %s and %s as no servers", (raw, legacy) => {
    expect(parseStoredServers(raw, legacy, newId)).toEqual([])
  })
})

describe("addPairing", () => {
  it("adds a server it has not seen", () => {
    const { servers, id } = addPairing([server()], { hosts: ["10.0.0.9"], port: 47821, token: "xyz" }, newId)
    expect(id).toBe("new")
    expect(servers.map((entry) => entry.id)).toEqual(["a", "new"])
  })

  it("updates the token of a server paired again at an address it had", () => {
    const { servers, id } = addPairing([server()], { hosts: ["192.168.1.5"], port: 47821, token: "rotated" }, newId)
    expect(id).toBe("a")
    expect(servers).toEqual([server({ hosts: ["192.168.1.5"], token: "rotated" })])
  })

  it("keeps a server on another port apart", () => {
    const { servers } = addPairing([server()], { hosts: ["192.168.1.5"], port: 47822, token: "abc" }, newId)
    expect(servers).toHaveLength(2)
  })
})
