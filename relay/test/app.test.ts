import { env } from "cloudflare:workers"
import { beforeEach, describe, expect, it } from "vitest"
import { makeApp } from "../src/app"
import { verifyOwner } from "../src/owner"
import { FakeCloudflare } from "./fake-cloudflare"

const SESSIONS: Record<string, string> = { "alice-session": "user_alice", "bob-session": "user_bob" }
const ORIGIN = "http://127.0.0.1:48081"

let clock: number
let cloudflare: FakeCloudflare
let app: ReturnType<typeof makeApp>

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM link"),
    env.DB.prepare("DELETE FROM host"),
    env.DB.prepare("DELETE FROM owner"),
  ])
  clock = Date.UTC(2026, 9, 24)
  cloudflare = new FakeCloudflare()
  app = makeApp({
    verifyUser: async (request) => SESSIONS[request.headers.get("Authorization")?.replace("Bearer ", "") ?? ""] ?? null,
    cloudflare: cloudflare.fetch,
    now: () => clock,
    random: (bytes) => crypto.getRandomValues(new Uint8Array(bytes)),
  })
})

const call = (method: string, path: string, options: { bearer?: string; body?: unknown } = {}) =>
  app.request(
    `https://relay.test${path}`,
    {
      method,
      headers: {
        ...(options.bearer && { Authorization: `Bearer ${options.bearer}` }),
        ...(options.body !== undefined && { "Content-Type": "application/json" }),
      },
      ...(options.body !== undefined && { body: JSON.stringify(options.body) }),
    },
    env,
  )

interface Link {
  deviceCode: string
  userCode: string
  url: string
  interval: number
  expiresAt: number
}

const startLink = async (environmentId = "env-1", name = "home-mac") => {
  const response = await call("POST", "/v1/links", { body: { environmentId, name } })
  expect(response.status).toBe(200)
  return (await response.json()) as Link
}

const claim = (deviceCode: string) => call("POST", "/v1/links/claim", { body: { deviceCode } })

const approve = (userCode: string, session = "alice-session") =>
  call("POST", `/v1/links/${userCode}`, { bearer: session })

const linkMachine = async (environmentId = "env-1", session = "alice-session") => {
  const link = await startLink(environmentId)
  expect((await approve(link.userCode, session)).status).toBe(204)
  const response = await claim(link.deviceCode)
  expect(response.status).toBe(200)
  return ((await response.json()) as { credential: string }).credential
}

const putTunnel = (credential: string, origin = ORIGIN) =>
  call("PUT", "/v1/tunnel", { bearer: credential, body: { origin } })

const hostRow = (environmentId = "env-1") =>
  env.DB.prepare("SELECT id, tunnel_id, dns_record_id FROM host WHERE environment_id = ?").bind(environmentId).first<{
    id: string
    tunnel_id: string | null
    dns_record_id: string | null
  }>()

describe("linking", () => {
  it("is pending until approved, then hands out a credential once", async () => {
    const link = await startLink()
    expect(link.userCode).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/)
    expect(link.url).toBe(`https://relay.test/link?code=${link.userCode}`)
    expect(link.interval).toBe(5)
    expect(link.expiresAt).toBe(clock + 10 * 60 * 1000)
    const stored = await env.DB.prepare("SELECT device_code_hash FROM link").first<string>("device_code_hash")
    expect(stored).toMatch(/^[0-9a-f]{64}$/)
    expect(stored).not.toBe(link.deviceCode)

    expect(await (await claim(link.deviceCode)).json()).toEqual({ pending: true })
    expect((await claim(link.deviceCode)).status).toBe(202)

    const prompt = await call("GET", `/v1/links/${link.userCode.toLowerCase()}`, { bearer: "alice-session" })
    expect(await prompt.json()).toEqual({ name: "home-mac", environmentId: "env-1" })
    expect((await approve(link.userCode)).status).toBe(204)

    const claimed = await claim(link.deviceCode)
    expect(claimed.status).toBe(200)
    const { credential } = (await claimed.json()) as { credential: string }
    expect(credential).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect((await claim(link.deviceCode)).status).toBe(410)
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM link").first("count")).toBe(0)
    expect((await hostRow())?.id).toMatch(/^[0-9a-f]{16}$/)
  })

  it("refuses an expired link", async () => {
    const link = await startLink()
    clock += 10 * 60 * 1000
    expect((await call("GET", `/v1/links/${link.userCode}`, { bearer: "alice-session" })).status).toBe(404)
    expect((await approve(link.userCode)).status).toBe(404)
    expect((await claim(link.deviceCode)).status).toBe(410)
    expect((await claim("never-issued")).status).toBe(410)
  })

  it("needs the owner's bearer to read or approve a link", async () => {
    const link = await startLink()
    expect((await call("GET", `/v1/links/${link.userCode}`)).status).toBe(401)
    expect((await approve(link.userCode, "forged")).status).toBe(401)
  })

  it("validates the link request", async () => {
    for (const body of [
      { environmentId: "env 1", name: "home-mac" },
      { environmentId: "e".repeat(65), name: "home-mac" },
      { environmentId: "env-1", name: "n".repeat(65) },
      { environmentId: "env-1" },
    ]) {
      const response = await call("POST", "/v1/links", { body })
      expect(response.status).toBe(400)
      expect(await response.json()).toHaveProperty("error")
    }
  })

  it("refuses a sixth machine but still re-links one of the five", async () => {
    for (const environmentId of ["env-1", "env-2", "env-3", "env-4", "env-5"]) await linkMachine(environmentId)
    const sixth = await startLink("env-6")
    const refused = await approve(sixth.userCode)
    expect(refused.status).toBe(409)
    expect(((await refused.json()) as { error: string }).error).toContain("5 machines")
    expect((await claim(sixth.deviceCode)).status).toBe(202)

    await linkMachine("env-3")
  })

  it("keeps the host id on a re-link and revokes the old credential", async () => {
    const first = await linkMachine()
    expect((await putTunnel(first)).status).toBe(200)
    const before = await hostRow()

    const second = await linkMachine()
    expect(await hostRow()).toEqual(before)
    expect((await putTunnel(first)).status).toBe(401)
    expect((await putTunnel(second)).status).toBe(200)
    expect(cloudflare.tunnels.size).toBe(1)
  })
})

describe("PUT /v1/tunnel", () => {
  it("creates the tunnel, its ingress and its CNAME from nothing", async () => {
    const credential = await linkMachine()
    const response = await putTunnel(credential)
    expect(response.status).toBe(200)
    const host = await hostRow()
    const [tunnel] = [...cloudflare.tunnels.values()]
    expect(await response.json()).toEqual({
      hostname: `${host?.id}.tunnels.test`,
      connectorToken: `token-${tunnel?.id}`,
    })
    expect(cloudflare.tunnels.size).toBe(1)
    expect(tunnel?.name).toBe(`hinacode-${host?.id}`)
    expect(cloudflare.configurations.get(tunnel!.id)).toEqual({
      config: {
        ingress: [
          { hostname: `${host?.id}.tunnels.test`, service: ORIGIN, originRequest: {} },
          { service: "http_status:404" },
        ],
      },
    })
    expect([...cloudflare.records.values()]).toEqual([
      {
        id: host?.dns_record_id,
        name: `${host?.id}.tunnels.test`,
        content: `${tunnel?.id}.cfargotunnel.com`,
        proxied: true,
      },
    ])
    expect(host?.tunnel_id).toBe(tunnel?.id)
  })

  it("converges on one tunnel and one record after the DNS call failed", async () => {
    const credential = await linkMachine()
    cloudflare.failNext("POST", /\/dns_records$/)
    const failed = await putTunnel(credential)
    expect(failed.status).toBe(502)
    expect(((await failed.json()) as { error: string }).error).toContain("Injected failure")
    expect((await hostRow())?.tunnel_id).toBe([...cloudflare.tunnels.keys()][0])

    expect((await putTunnel(credential)).status).toBe(200)
    expect(cloudflare.tunnels.size).toBe(1)
    expect(cloudflare.records.size).toBe(1)
    expect(cloudflare.calls.filter((line) => line === "POST /accounts/account/cfd_tunnel")).toHaveLength(1)
  })

  it("points a stale CNAME at the tunnel", async () => {
    const credential = await linkMachine()
    const host = await hostRow()
    cloudflare.records.set("stale", {
      id: "stale",
      name: `${host?.id}.tunnels.test`,
      content: "gone.cfargotunnel.com",
      proxied: true,
    })
    expect((await putTunnel(credential)).status).toBe(200)
    const [tunnelId] = [...cloudflare.tunnels.keys()]
    expect(cloudflare.records.get("stale")?.content).toBe(`${tunnelId}.cfargotunnel.com`)
    expect(cloudflare.records.size).toBe(1)
    expect(cloudflare.calls).toContain("PATCH /zones/zone/dns_records/stale")
    expect((await hostRow())?.dns_record_id).toBe("stale")
  })

  it("accepts only http://<address>:<port>", async () => {
    const credential = await linkMachine()
    for (const origin of [
      "https://127.0.0.1:48081",
      "http://127.0.0.1",
      "http://127.0.0.1:48081/remote",
      "http://127.0.0.1:48081?x=1",
      "http://a b:80",
      "http://127.0.0.1:123456",
    ]) {
      expect((await putTunnel(credential, origin)).status).toBe(400)
    }
    expect((await putTunnel(credential, "http://[::1]:48081")).status).toBe(200)
    expect(cloudflare.calls.filter((line) => line.startsWith("POST"))).toHaveLength(2)
  })

  it("needs the machine credential", async () => {
    expect((await call("PUT", "/v1/tunnel", { body: { origin: ORIGIN } })).status).toBe(401)
    expect((await putTunnel("not-a-credential")).status).toBe(401)
  })
})

describe("unlinking", () => {
  it("tolerates a tunnel and record Cloudflare already deleted", async () => {
    const credential = await linkMachine()
    expect((await putTunnel(credential)).status).toBe(200)
    cloudflare.tunnels.clear()
    cloudflare.records.clear()

    expect((await call("DELETE", "/v1/host", { bearer: credential })).status).toBe(204)
    expect(await hostRow()).toBeNull()
    expect((await putTunnel(credential)).status).toBe(401)
  })

  it("deletes the record, then the tunnel", async () => {
    const credential = await linkMachine()
    expect((await putTunnel(credential)).status).toBe(200)
    const host = await hostRow()
    expect((await call("DELETE", "/v1/host", { bearer: credential })).status).toBe(204)
    expect(cloudflare.calls.slice(-2)).toEqual([
      `DELETE /zones/zone/dns_records/${host?.dns_record_id}`,
      `DELETE /accounts/account/cfd_tunnel/${host?.tunnel_id}`,
    ])
    expect(cloudflare.tunnels.size).toBe(0)
    expect(cloudflare.records.size).toBe(0)
  })
})

describe("the account's machines", () => {
  it("lists only the caller's hosts", async () => {
    await linkMachine("env-a", "alice-session")
    await linkMachine("env-b", "bob-session")
    const response = await call("GET", "/v1/hosts", { bearer: "alice-session" })
    const { hosts } = (await response.json()) as { hosts: { id: string; name: string; hostname: string }[] }
    expect(hosts).toEqual([
      {
        id: (await hostRow("env-a"))?.id,
        name: "home-mac",
        hostname: `${(await hostRow("env-a"))?.id}.tunnels.test`,
        createdAt: clock,
        enabled: true,
        published: false,
      },
    ])
    expect((await call("GET", "/v1/hosts")).status).toBe(401)
  })

  it("removes only the caller's own host", async () => {
    await linkMachine("env-b", "bob-session")
    const bobs = await hostRow("env-b")
    expect((await call("DELETE", `/v1/hosts/${bobs?.id}`, { bearer: "alice-session" })).status).toBe(404)
    expect(await hostRow("env-b")).not.toBeNull()

    expect((await call("DELETE", `/v1/hosts/${bobs?.id}`, { bearer: "bob-session" })).status).toBe(204)
    expect(await hostRow("env-b")).toBeNull()
  })
})

const PAIRING = { hosts: ["192.168.1.20", "home-mac.local"], port: 48081, token: "pairing-token" }

const publish = (credential: string, pairing: unknown = PAIRING) =>
  call("PUT", "/v1/host/pairing", { bearer: credential, body: pairing })

const machines = async (session = "alice-session") => {
  const response = await call("GET", "/v1/machines", { bearer: session })
  expect(response.status).toBe(200)
  return ((await response.json()) as { machines: unknown[] }).machines
}

const setEnabled = (id: string | undefined, enabled: boolean, session = "alice-session") =>
  call("PATCH", `/v1/hosts/${id}`, { bearer: session, body: { enabled } })

describe("the machines the owner's devices see", () => {
  it("lists a published machine with its relay hostname, uncached", async () => {
    expect((await publish(await linkMachine())).status).toBe(204)
    const response = await call("GET", "/v1/machines", { bearer: "alice-session" })
    expect(response.headers.get("Cache-Control")).toBe("no-store")
    const id = (await hostRow())?.id
    expect(await response.json()).toEqual({
      machines: [{ environmentId: "env-1", name: "home-mac", pairing: { ...PAIRING, relay: `${id}.tunnels.test` } }],
    })
    expect((await call("GET", "/v1/machines")).status).toBe(401)
  })

  it("leaves out an unpublished machine, a hidden one and another account's", async () => {
    await linkMachine("env-unpublished")
    await publish(await linkMachine("env-hidden"))
    expect((await setEnabled((await hostRow("env-hidden"))?.id, false)).status).toBe(204)
    await publish(await linkMachine("env-bob", "bob-session"))
    await publish(await linkMachine("env-shown"))
    expect((await machines()).map((machine) => (machine as { environmentId: string }).environmentId)).toEqual([
      "env-shown",
    ])

    expect((await setEnabled((await hostRow("env-hidden"))?.id, true)).status).toBe(204)
    expect(await machines()).toHaveLength(2)
  })

  it("skips a row whose stored pairing no longer decodes", async () => {
    await publish(await linkMachine())
    await env.DB.prepare("UPDATE host SET pairing = ?").bind('{"hosts":[]}').run()
    expect(await machines()).toEqual([])
  })

  it("replaces the pairing when the machine publishes again", async () => {
    const credential = await linkMachine()
    await publish(credential)
    expect((await publish(credential, { ...PAIRING, hosts: ["10.0.0.5"], token: "rotated" })).status).toBe(204)
    expect(await machines()).toMatchObject([{ pairing: { hosts: ["10.0.0.5"], port: 48081, token: "rotated" } }])
  })

  it("takes a pairing only from a linked machine", async () => {
    const unlinked = await call("PUT", "/v1/host/pairing", { body: PAIRING })
    expect(unlinked.status).toBe(401)
    expect(await unlinked.json()).toEqual({ error: "This machine is not linked. Link it again." })
    expect((await publish("alice-session")).status).toBe(401)
    expect((await publish("not-a-credential")).status).toBe(401)
  })

  it("refuses a malformed pairing", async () => {
    const credential = await linkMachine()
    for (const pairing of [
      { ...PAIRING, hosts: [] },
      { ...PAIRING, hosts: Array.from({ length: 17 }, (_, index) => `10.0.0.${index}`) },
      { ...PAIRING, hosts: [""] },
      { ...PAIRING, hosts: ["h".repeat(256)] },
      { ...PAIRING, hosts: ["home mac"] },
      { ...PAIRING, hosts: ["evil.test/path"] },
      { ...PAIRING, hosts: ["user@evil.test"] },
      { ...PAIRING, hosts: ["[::1]"] },
      { ...PAIRING, hosts: ["a?b"] },
      { ...PAIRING, hosts: ["a#b"] },
      { ...PAIRING, hosts: ["a\\b"] },
      { ...PAIRING, port: 0 },
      { ...PAIRING, port: 65536 },
      { ...PAIRING, port: 80.5 },
      { ...PAIRING, token: "" },
      { ...PAIRING, token: "t".repeat(257) },
      { hosts: PAIRING.hosts, port: PAIRING.port },
      "not an object",
    ]) {
      const response = await publish(credential, pairing)
      expect(response.status, JSON.stringify(pairing)).toBe(400)
      expect(await response.json()).toHaveProperty("error")
    }
    expect((await publish(credential, { ...PAIRING, hosts: ["::1", "h".repeat(255)], port: 65535 })).status).toBe(204)
  })

  it("reports enabled and published in the host list", async () => {
    await publish(await linkMachine())
    await setEnabled((await hostRow())?.id, false)
    const { hosts } = (await (await call("GET", "/v1/hosts", { bearer: "alice-session" })).json()) as {
      hosts: { enabled: boolean; published: boolean }[]
    }
    expect(hosts).toMatchObject([{ enabled: false, published: true }])
  })

  it("toggles only the caller's own host", async () => {
    await linkMachine("env-b", "bob-session")
    const bobs = (await hostRow("env-b"))?.id
    expect((await setEnabled(bobs, false)).status).toBe(404)
    expect((await setEnabled("missing", false)).status).toBe(404)
    expect((await call("PATCH", `/v1/hosts/${bobs}`, { body: { enabled: false } })).status).toBe(401)
    for (const body of [{}, { enabled: "no" }, { enabled: 0 }]) {
      expect((await call("PATCH", `/v1/hosts/${bobs}`, { bearer: "bob-session", body })).status).toBe(400)
    }
    expect((await setEnabled(bobs, false, "bob-session")).status).toBe(204)
    expect(await env.DB.prepare("SELECT enabled FROM host").first("enabled")).toBe(0)
  })

  it("keeps the pairing and the hidden state across a re-link", async () => {
    await publish(await linkMachine())
    await setEnabled((await hostRow())?.id, false)
    const second = await linkMachine()
    const row = await env.DB.prepare("SELECT pairing, enabled FROM host").first<{ pairing: string; enabled: number }>()
    expect(JSON.parse(row!.pairing)).toEqual(PAIRING)
    expect(row?.enabled).toBe(0)
    expect((await publish(second)).status).toBe(204)
  })
})

describe("GET /link", () => {
  it("refuses to be framed, so Approve cannot be clicked through an overlay", async () => {
    const response = await call("GET", "/link?code=ABCD-EFGH")
    expect(response.headers.get("Content-Security-Policy")).toBe("frame-ancestors 'none'")
    expect(response.headers.get("X-Frame-Options")).toBe("DENY")
  })
})

describe("POST /v1/owner/token", () => {
  beforeEach(() => {
    app = makeApp({
      verifyUser: verifyOwner,
      cloudflare: cloudflare.fetch,
      now: () => clock,
      random: (bytes) => crypto.getRandomValues(new Uint8Array(bytes)),
    })
  })

  it("replaces the owner token, so the old one stops working", async () => {
    expect((await call("GET", "/v1/hosts", { bearer: env.OWNER_TOKEN })).status).toBe(200)

    const rotated = await call("POST", "/v1/owner/token", { bearer: env.OWNER_TOKEN })
    expect(rotated.status).toBe(200)
    const { token } = (await rotated.json()) as { token: string }
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)

    expect((await call("GET", "/v1/hosts", { bearer: env.OWNER_TOKEN })).status).toBe(401)
    expect((await call("GET", "/v1/hosts", { bearer: token })).status).toBe(200)
    const stored = await env.DB.prepare("SELECT token_hash FROM owner").first<string>("token_hash")
    expect(stored).not.toBe(token)

    const again = await call("POST", "/v1/owner/token", { bearer: token })
    const { token: next } = (await again.json()) as { token: string }
    expect((await call("GET", "/v1/hosts", { bearer: token })).status).toBe(401)
    expect((await call("GET", "/v1/hosts", { bearer: next })).status).toBe(200)
  })

  it("needs the current owner token", async () => {
    expect((await call("POST", "/v1/owner/token")).status).toBe(401)
    expect((await call("POST", "/v1/owner/token", { bearer: "guess" })).status).toBe(401)
  })
})
