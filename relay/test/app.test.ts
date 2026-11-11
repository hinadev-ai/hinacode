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
  await env.DB.batch([
    env.DB.prepare("DELETE FROM link"),
    env.DB.prepare("DELETE FROM host"),
    env.DB.prepare("DELETE FROM device"),
    env.DB.prepare("DELETE FROM sign_in_code"),
  ])
  clock = Date.UTC(2026, 9, 24)
  cloudflare = new FakeCloudflare()
  app = makeApp({
    verifySession: async (request) =>
      SESSIONS[request.headers.get("Authorization")?.replace("Bearer ", "") ?? ""] ?? null,
    accountProfile: async (userId) => ({
      name: userId,
      email: `${userId}@example.com`,
      imageUrl: `https://img.example.com/${userId}`,
    }),
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
    expect(link.userCode).toMatch(/^[A-Za-z0-9_-]{22}$/)
    expect(link.url).toBe(`https://relay.test/link?code=${link.userCode}`)
    expect(link.interval).toBe(5)
    expect(link.expiresAt).toBe(clock + 10 * 60 * 1000)
    const stored = await env.DB.prepare("SELECT device_code_hash FROM link").first<string>("device_code_hash")
    expect(stored).toMatch(/^[0-9a-f]{64}$/)
    expect(stored).not.toBe(link.deviceCode)

    expect(await (await claim(link.deviceCode)).json()).toEqual({ pending: true })
    expect((await claim(link.deviceCode)).status).toBe(202)

    const prompt = await call("GET", `/v1/links/${link.userCode}`, { bearer: "alice-session" })
    expect(await prompt.json()).toEqual({ kind: "machine", name: "home-mac", environmentId: "env-1" })
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

  it("tells the waiting machine it was denied, once", async () => {
    const link = await startLink()
    const deny = (session?: string) => call("DELETE", `/v1/links/${link.userCode}`, { bearer: session })
    expect((await deny()).status).toBe(401)
    expect((await deny("alice-session")).status).toBe(204)
    expect((await deny("alice-session")).status).toBe(404)
    expect((await approve(link.userCode)).status).toBe(404)
    const refused = await claim(link.deviceCode)
    expect(refused.status).toBe(403)
    expect(await refused.json()).toEqual({ error: "The request was denied in the browser." })
    expect((await claim(link.deviceCode)).status).toBe(410)
  })

  it("refuses to deny a link that was already approved", async () => {
    const link = await startLink()
    expect((await approve(link.userCode, "alice-session")).status).toBe(204)
    expect((await call("DELETE", `/v1/links/${link.userCode}`, { bearer: "bob-session" })).status).toBe(409)
    expect((await claim(link.deviceCode)).status).toBe(200)
    expect((await call("DELETE", `/v1/links/${link.userCode}`, { bearer: "alice-session" })).status).toBe(404)
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

  it("refuses a sixth machine whose link was approved before the fifth was claimed", async () => {
    for (const environmentId of ["env-1", "env-2", "env-3", "env-4"]) await linkMachine(environmentId)
    const fifth = await startLink("env-5")
    const sixth = await startLink("env-6")
    expect((await approve(fifth.userCode)).status).toBe(204)
    expect((await approve(sixth.userCode)).status).toBe(204)
    expect((await claim(fifth.deviceCode)).status).toBe(200)

    const refused = await claim(sixth.deviceCode)
    expect(refused.status).toBe(409)
    expect(((await refused.json()) as { error: string }).error).toContain("5 machines")
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM host").first("count")).toBe(5)
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
        environmentId: "env-a",
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

describe("the web app", () => {
  const preflight = (origin: string) =>
    app.request(
      "https://relay.test/v1/machines",
      {
        method: "OPTIONS",
        headers: {
          Origin: origin,
          "Access-Control-Request-Method": "GET",
          "Access-Control-Request-Headers": "authorization",
        },
      },
      env,
    )

  it("lets the web app's origin list the machines with a Clerk session", async () => {
    const response = await preflight("https://code.test")
    expect(response.status).toBe(204)
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("https://code.test")
    expect(response.headers.get("Access-Control-Allow-Headers")?.toLowerCase()).toContain("authorization")
    const listed = await app.request(
      "https://relay.test/v1/machines",
      { headers: { Origin: "https://code.test", Authorization: "Bearer alice-session" } },
      env,
    )
    expect(listed.headers.get("Access-Control-Allow-Origin")).toBe("https://code.test")
  })

  it("gives any other origin no CORS grant", async () => {
    expect((await preflight("https://evil.test")).headers.get("Access-Control-Allow-Origin")).toBeNull()
  })
})

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

describe("the code in a link", () => {
  it("is too long to guess, and only the exact code finds the link", async () => {
    const link = await startLink()
    expect(link.userCode).toMatch(/^[A-Za-z0-9_-]{22}$/)
    const flipped = link.userCode.replace(/[A-Za-z]/, (letter) =>
      letter === letter.toLowerCase() ? letter.toUpperCase() : letter.toLowerCase(),
    )
    expect((await call("GET", `/v1/links/${flipped}`, { bearer: "alice-session" })).status).toBe(404)
  })

  it("does not approve anything by being read after signing in", async () => {
    const link = await startLink()
    expect((await call("GET", `/v1/links/${link.userCode}`, { bearer: "alice-session" })).status).toBe(200)
    expect((await claim(link.deviceCode)).status).toBe(202)
  })
})

describe("approving one code from two accounts at once", () => {
  it("gives the machine to the account told it won", async () => {
    const link = await startLink()
    const [alice, bob] = await Promise.all([
      approve(link.userCode, "alice-session"),
      approve(link.userCode, "bob-session"),
    ])
    expect([alice.status, bob.status].toSorted()).toEqual([204, 409])

    await claim(link.deviceCode)
    const winner = alice.status === 204 ? "user_alice" : "user_bob"
    const owner = await env.DB.prepare("SELECT user_id FROM host").first<string>("user_id")
    expect(owner).toBe(winner)
  })
})

describe("GET /link", () => {
  it("refuses to be framed, so Approve cannot be clicked through an overlay", async () => {
    const response = await call("GET", "/link?code=ABCD-EFGH")
    expect(response.headers.get("Content-Security-Policy")).toBe("frame-ancestors 'none'")
    expect(response.headers.get("X-Frame-Options")).toBe("DENY")
  })

  it("loads Clerk from the instance the publishable key names", async () => {
    const page = await (await call("GET", "/link")).text()
    expect(page).toContain('data-clerk-publishable-key="pk_test_Y2xlcmsudGVzdCQ"')
    expect(page).toContain('src="https://clerk.test/npm/@clerk/clerk-js@6/dist/clerk.browser.js"')
    expect(page).not.toContain("sk_test_fake")
  })
})

const signIn = async (session: string, name = "laptop") => {
  const started = await call("POST", "/v1/sign-ins", { body: { name } })
  expect(started.status).toBe(200)
  const { deviceCode, userCode } = (await started.json()) as Link
  expect((await approve(userCode, session)).status).toBe(204)
  const claimed = await claim(deviceCode)
  expect(claimed.status).toBe(200)
  return ((await claimed.json()) as { credential: string }).credential
}

const hostsSeenBy = (bearer: string) => call("GET", "/v1/hosts", { bearer })

describe("signing in on the web app", () => {
  it("hands the web app the Clerk key it signs in with", async () => {
    const response = await call("GET", "/v1/config")
    expect(await response.json()).toEqual({ clerkPublishableKey: env.CLERK_PUBLISHABLE_KEY })
  })

  it("trades a Clerk session for a device credential the browser keeps", async () => {
    const response = await call("POST", "/v1/devices", {
      bearer: "alice-session",
      body: { name: "HinaCode in a browser" },
    })
    expect(response.status).toBe(200)
    const { credential } = (await response.json()) as { credential: string }
    expect((await call("GET", "/v1/hosts", { bearer: credential })).status).toBe(200)
    expect((await call("DELETE", "/v1/device", { bearer: credential })).status).toBe(204)
  })

  it("refuses a device credential, so one device cannot mint another", async () => {
    const first = await call("POST", "/v1/devices", { bearer: "alice-session", body: { name: "browser" } })
    const { credential } = (await first.json()) as { credential: string }
    expect((await call("POST", "/v1/devices", { bearer: credential, body: { name: "copy" } })).status).toBe(401)
    expect((await call("POST", "/v1/devices", { body: { name: "copy" } })).status).toBe(401)
    expect((await call("POST", "/v1/devices", { bearer: "alice-session", body: { name: "" } })).status).toBe(400)
  })
})

describe("signing in a device", () => {
  it("stays pending until a session approves it, and claims once", async () => {
    const started = (await (await call("POST", "/v1/sign-ins", { body: { name: "laptop" } })).json()) as Link
    expect((await claim(started.deviceCode)).status).toBe(202)
    const prompt = await call("GET", `/v1/links/${started.userCode}`, { bearer: "alice-session" })
    expect(await prompt.json()).toMatchObject({ kind: "device", name: "laptop" })
    await approve(started.userCode, "alice-session")
    expect((await claim(started.deviceCode)).status).toBe(200)
    expect((await claim(started.deviceCode)).status).toBe(410)
  })

  it("lets a device act as the account that approved it, and stores only a hash", async () => {
    const credential = await signIn("alice-session")
    expect(credential).toMatch(/^[A-Za-z0-9_-]{43}$/)
    const profile = await call("GET", "/v1/account", { bearer: credential })
    expect(await profile.json()).toEqual({
      name: "user_alice",
      email: "user_alice@example.com",
      imageUrl: "https://img.example.com/user_alice",
    })
    const stored = await env.DB.prepare("SELECT user_id, credential_hash FROM device").first<{
      user_id: string
      credential_hash: string
    }>()
    expect(stored?.user_id).toBe("user_alice")
    expect(stored?.credential_hash).not.toBe(credential)
  })

  it("keeps a second device from signing out the first", async () => {
    const laptop = await signIn("alice-session", "laptop")
    const phone = await signIn("alice-session", "phone")
    expect((await hostsSeenBy(laptop)).status).toBe(200)
    expect((await hostsSeenBy(phone)).status).toBe(200)
  })

  it("keeps each account's machines apart", async () => {
    const link = await startLink()
    await approve(link.userCode, "alice-session")
    await claim(link.deviceCode)
    const count = async (session: string) => {
      const response = await hostsSeenBy(await signIn(session))
      return ((await response.json()) as { hosts: unknown[] }).hosts.length
    }
    expect(await count("alice-session")).toBe(1)
    expect(await count("bob-session")).toBe(0)
  })

  it("does not count towards the machine limit or add a machine", async () => {
    for (const index of [1, 2, 3, 4, 5, 6]) await signIn("alice-session", `device-${index}`)
    const hosts = await env.DB.prepare("SELECT COUNT(*) AS count FROM host").first<number>("count")
    expect(hosts).toBe(0)
  })

  it("needs a session, so a stolen credential cannot sign in more devices", async () => {
    const credential = await signIn("alice-session")
    const started = (await (await call("POST", "/v1/sign-ins", { body: { name: "thief" } })).json()) as Link
    expect((await call("GET", `/v1/links/${started.userCode}`, { bearer: credential })).status).toBe(403)
    expect((await approve(started.userCode, credential)).status).toBe(403)
    expect((await claim(started.deviceCode)).status).toBe(202)
  })

  it("lets a device approve a machine link", async () => {
    const credential = await signIn("alice-session")
    const link = await startLink()
    expect((await approve(link.userCode, credential)).status).toBe(204)
  })
})

describe("signing out", () => {
  it("ends only the device that asks", async () => {
    const laptop = await signIn("alice-session", "laptop")
    const phone = await signIn("alice-session", "phone")
    expect((await call("DELETE", "/v1/device", { bearer: laptop })).status).toBe(204)
    expect((await hostsSeenBy(laptop)).status).toBe(401)
    expect((await hostsSeenBy(phone)).status).toBe(200)
  })

  it("ends every device of one account from a session", async () => {
    const alices = await signIn("alice-session")
    const bobs = await signIn("bob-session")
    expect((await call("DELETE", "/v1/devices", { bearer: "alice-session" })).status).toBe(204)
    expect((await hostsSeenBy(alices)).status).toBe(401)
    expect((await hostsSeenBy(bobs)).status).toBe(200)
  })

  it("also ends a sign-in that was approved but not claimed yet", async () => {
    const started = (await (await call("POST", "/v1/sign-ins", { body: { name: "phone" } })).json()) as Link
    await approve(started.userCode, "alice-session")
    expect((await call("DELETE", "/v1/devices", { bearer: "alice-session" })).status).toBe(204)
    expect((await claim(started.deviceCode)).status).toBe(410)
  })

  it("leaves a machine link alone when ending every device", async () => {
    const link = await startLink()
    await approve(link.userCode, "alice-session")
    expect((await call("DELETE", "/v1/devices", { bearer: "alice-session" })).status).toBe(204)
    expect((await claim(link.deviceCode)).status).toBe(200)
  })

  it("refuses to end every device from a credential", async () => {
    const credential = await signIn("alice-session")
    expect((await call("DELETE", "/v1/devices", { bearer: credential })).status).toBe(401)
    expect((await call("DELETE", "/v1/devices")).status).toBe(401)
    expect((await hostsSeenBy(credential)).status).toBe(200)
  })

  it("refuses a device sign-out without a known credential", async () => {
    expect((await call("DELETE", "/v1/device")).status).toBe(401)
    expect((await call("DELETE", "/v1/device", { bearer: "guess" })).status).toBe(401)
  })
})

const base64Url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "")

const pkce = async () => {
  const verifier = base64Url(crypto.getRandomValues(new Uint8Array(32)))
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))
  return { verifier, challenge: base64Url(new Uint8Array(digest)) }
}

const LOOPBACK = "http://127.0.0.1:53123/callback"

const requestCode = (
  bearer: string | undefined,
  redirectUri = LOOPBACK,
  codeChallenge = "c".repeat(43),
  name = "laptop",
) => call("POST", "/v1/sign-in-codes", { bearer, body: { redirectUri, codeChallenge, name } })

const issueCode = async (redirectUri = LOOPBACK) => {
  const { verifier, challenge } = await pkce()
  const response = await requestCode("alice-session", redirectUri, challenge)
  expect(response.status).toBe(200)
  const { redirectUrl } = (await response.json()) as { redirectUrl: string }
  return { verifier, redirectUrl, code: new URL(redirectUrl).searchParams.get("code") ?? "" }
}

const exchange = (code: string, codeVerifier: string) =>
  call("POST", "/v1/sign-in-codes/exchange", { body: { code, codeVerifier } })

describe("signing in by redirect", () => {
  it("needs a Clerk session and refuses a device credential", async () => {
    expect((await requestCode(undefined)).status).toBe(401)
    expect((await requestCode(await signIn("alice-session"))).status).toBe(401)
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM sign_in_code").first("count")).toBe(0)
  })

  it("redirects only to a loopback port or the app's scheme", async () => {
    for (const redirectUri of [
      "https://evil.example/cb",
      "http://localhost:1234/cb",
      "http://127.0.0.1/cb",
      "hinacode://x?y=1",
      "http://127.0.0.1:53123/cb#x",
      "not a url",
    ]) {
      const response = await requestCode("alice-session", redirectUri)
      expect(response.status, redirectUri).toBe(400)
      expect(((await response.json()) as { error: string }).error).toContain("redirectUri")
    }
    for (const codeChallenge of ["short", "c".repeat(44), `${"c".repeat(42)}=`]) {
      expect((await requestCode("alice-session", LOOPBACK, codeChallenge)).status).toBe(400)
    }
  })

  it("puts the code in the redirect and stores only its hash", async () => {
    for (const redirectUri of [LOOPBACK, "hinacode://signed-in"]) {
      const { redirectUrl, code } = await issueCode(redirectUri)
      expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/)
      expect(redirectUrl).toBe(`${redirectUri}?code=${code}`)
    }
    const stored = await env.DB.prepare("SELECT code_hash, expires_at FROM sign_in_code").all<{
      code_hash: string
      expires_at: number
    }>()
    expect(stored.results).toHaveLength(2)
    for (const row of stored.results) {
      expect(row.code_hash).toMatch(/^[0-9a-f]{64}$/)
      expect(row.expires_at).toBe(clock + 2 * 60 * 1000)
    }
  })

  it("exchanges the code once for a credential that acts as the account", async () => {
    const { code, verifier } = await issueCode()
    const response = await exchange(code, verifier)
    expect(response.status).toBe(200)
    const { credential } = (await response.json()) as { credential: string }
    const profile = await call("GET", "/v1/account", { bearer: credential })
    expect(await profile.json()).toEqual({
      name: "user_alice",
      email: "user_alice@example.com",
      imageUrl: "https://img.example.com/user_alice",
    })
    expect(await env.DB.prepare("SELECT name FROM device").first("name")).toBe("laptop")

    const again = await exchange(code, verifier)
    expect(again.status).toBe(410)
    expect(await again.json()).toEqual({ error: "The sign-in expired or was already used. Sign in again." })
  })

  it("spends the code on a wrong verifier", async () => {
    const { code, verifier } = await issueCode()
    expect((await exchange(code, (await pkce()).verifier)).status).toBe(410)
    expect((await exchange(code, verifier)).status).toBe(410)
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM device").first("count")).toBe(0)
  })

  it("refuses an expired code", async () => {
    const { code, verifier } = await issueCode()
    clock += 2 * 60 * 1000
    expect((await exchange(code, verifier)).status).toBe(410)
  })

  it("is ended by signing out every device", async () => {
    const { code, verifier } = await issueCode()
    expect((await call("DELETE", "/v1/devices", { bearer: "alice-session" })).status).toBe(204)
    expect((await exchange(code, verifier)).status).toBe(410)
  })

  it("serves the sign-in and signed-in pages unframeable", async () => {
    for (const path of ["/sign-in?redirect_uri=x", "/signed-in"]) {
      const response = await call("GET", path)
      expect(response.status).toBe(200)
      expect(response.headers.get("Content-Type")).toContain("text/html")
      expect(response.headers.get("X-Frame-Options")).toBe("DENY")
    }
    expect(await (await call("GET", "/sign-in")).text()).toContain("clerk.browser.js")
    expect(await (await call("GET", "/signed-in")).text()).not.toContain("clerk")
  })
})

const verifyOnMachine = (credential: string, code: string, codeVerifier: string) =>
  call("POST", "/v1/host/sign-in-codes/verify", { bearer: credential, body: { code, codeVerifier } })

describe("signing in to approve an app on one of your machines", () => {
  const approvalUri = async (environmentId = "env-1") =>
    `https://${(await hostRow(environmentId))?.id}.tunnels.test/oauth/signed-in`

  it("returns only to the signed-in account's own machines, on the approval path", async () => {
    await linkMachine("env-1")
    await linkMachine("env-bob", "bob-session")
    const own = await approvalUri()
    expect((await requestCode("alice-session", own)).status).toBe(200)
    for (const redirectUri of [
      await approvalUri("env-bob"),
      own.replace("https:", "http:"),
      own.replace("/oauth/signed-in", "/elsewhere"),
      `${own}?request=1`,
      own.replace(".tunnels.test", ".tunnels.test:8443"),
      "https://unknown.tunnels.test/oauth/signed-in",
    ]) {
      expect((await requestCode("alice-session", redirectUri)).status, redirectUri).toBe(400)
    }
  })

  it("lets only that machine redeem the code, once, and never as a device", async () => {
    const credential = await linkMachine("env-1")
    const other = await linkMachine("env-2")
    const { code, verifier } = await issueCode(await approvalUri())
    expect((await verifyOnMachine(other, code, verifier)).status).toBe(410)

    const second = await issueCode(await approvalUri())
    expect((await exchange(second.code, second.verifier)).status).toBe(410)

    const third = await issueCode(await approvalUri())
    expect((await verifyOnMachine(credential, third.code, (await pkce()).verifier)).status).toBe(410)

    const fourth = await issueCode(await approvalUri())
    const verified = await verifyOnMachine(credential, fourth.code, fourth.verifier)
    expect(verified.status).toBe(200)
    expect(await verified.json()).toEqual({ name: "user_alice", email: "user_alice@example.com" })
    expect((await verifyOnMachine(credential, fourth.code, fourth.verifier)).status).toBe(410)
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM device").first("count")).toBe(0)

    expect((await verifyOnMachine("not-a-machine", code, verifier)).status).toBe(401)
  })
})
