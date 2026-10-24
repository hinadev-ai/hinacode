import { env } from "cloudflare:workers"
import { beforeEach, describe, expect, it } from "vitest"
import { makeApp } from "../src/app"
import { FakeCloudflare } from "./fake-cloudflare"

const SESSIONS: Record<string, string> = { "alice-session": "user_alice", "bob-session": "user_bob" }
const ORIGIN = "http://127.0.0.1:48081"

let clock: number
let cloudflare: FakeCloudflare
let app: ReturnType<typeof makeApp>

beforeEach(async () => {
  await env.DB.batch([env.DB.prepare("DELETE FROM link"), env.DB.prepare("DELETE FROM host")])
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

  it("needs a Clerk session to read or approve a link", async () => {
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

describe("GET /link", () => {
  it("serves the page with Clerk loaded from the key's Frontend API", async () => {
    const response = await call("GET", "/link?code=ABCD-EFGH")
    expect(response.headers.get("Content-Type")).toContain("text/html")
    const html = await response.text()
    expect(html).toContain('src="https://example.clerk.accounts.dev/npm/@clerk/clerk-js@6/dist/clerk.browser.js"')
    expect(html).toContain("Return to HinaCode. It connects on its own.")
  })

  it("refuses to be framed, so Approve cannot be clicked through an overlay", async () => {
    const response = await call("GET", "/link?code=ABCD-EFGH")
    expect(response.headers.get("Content-Security-Policy")).toBe("frame-ancestors 'none'")
    expect(response.headers.get("X-Frame-Options")).toBe("DENY")
  })
})
