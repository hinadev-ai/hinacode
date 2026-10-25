import { Option, Schema } from "effect"
import { Hono, type Context } from "hono"
import { CloudflareError, makeCloudflare, type Fetch } from "./cloudflare"
import { linkPage } from "./page"

export type { Fetch } from "./cloudflare"

export interface Deps {
  /** The user id behind the request's bearer, or null when it has none or an invalid one. */
  verifyUser(request: Request, env: Env): Promise<string | null>
  /** Reaches the Cloudflare API. */
  cloudflare: Fetch
  now(): number
  random(bytes: number): Uint8Array
}

type App = { Bindings: Env }

const LINK_TTL_MS = 10 * 60 * 1000
const POLL_INTERVAL_S = 5
const MAX_HOSTS = 5
const USER_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"

const Label = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(64))
const NewLink = Schema.Struct({
  environmentId: Label.check(Schema.isPattern(/^[A-Za-z0-9-]+$/)),
  name: Label,
})
const Claim = Schema.Struct({ deviceCode: Schema.String.check(Schema.isMaxLength(128)) })
const Tunnel = Schema.Struct({ origin: Schema.String.check(Schema.isPattern(/^http:\/\/[^/?#\s]+:\d{1,5}$/)) })
const Pairing = Schema.Struct({
  hosts: Schema.NonEmptyArray(
    Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(255), Schema.isPattern(/^[^\s/?#@[\]\\]+$/)),
  ).check(Schema.isMaxLength(16)),
  port: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 })),
  token: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(256)),
})
const StoredPairing = Schema.fromJsonString(Pairing)
const HostChange = Schema.Struct({ enabled: Schema.Boolean })

interface LinkRow {
  device_code_hash: string
  user_code: string
  environment_id: string
  name: string
  user_id: string | null
  expires_at: number
}

interface HostRow {
  id: string
  user_id: string
  environment_id: string
  name: string
  tunnel_id: string | null
  dns_record_id: string | null
  created_at: number
  pairing: string | null
  enabled: number
}

export const bearer = (request: Request) => /^Bearer (\S+)$/.exec(request.headers.get("Authorization") ?? "")?.[1]

const toHex = (bytes: Uint8Array) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")

const toBase64Url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "")

export const sha256 = async (value: string) =>
  toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))))

/** Accepts a code as typed, in any case and with or without the dash. */
const normalizeUserCode = (code: string) => {
  const plain = code.toUpperCase().replace(/[^A-Z0-9]/g, "")
  return `${plain.slice(0, 4)}-${plain.slice(4)}`
}

const hostnameOf = (env: Env, host: Pick<HostRow, "id">) => `${host.id}.${env.TUNNEL_ZONE_NAME}`

const fail = (c: Context, status: 400 | 401 | 404 | 409 | 410, error: string) => c.json({ error }, status)

const body = async <A>(c: Context, schema: Schema.Decoder<A>) =>
  Schema.decodeUnknownOption(schema)(await c.req.json().catch(() => undefined))

export const makeApp = (deps: Deps) => {
  const app = new Hono<App>()

  const cloudflare = (env: Env) =>
    makeCloudflare(deps.cloudflare, {
      apiToken: env.CLOUDFLARE_API_TOKEN,
      accountId: env.CLOUDFLARE_ACCOUNT_ID,
      zoneId: env.TUNNEL_ZONE_ID,
    })

  const machine = async (c: Context<App>) => {
    const credential = bearer(c.req.raw)
    if (!credential) return null
    return c.env.DB.prepare("SELECT * FROM host WHERE credential_hash = ?")
      .bind(await sha256(credential))
      .first<HostRow>()
  }

  const pendingLink = (env: Env, userCode: string) =>
    env.DB.prepare("SELECT * FROM link WHERE user_code = ? AND expires_at > ?")
      .bind(normalizeUserCode(userCode), deps.now())
      .first<LinkRow>()

  const removeHost = async (env: Env, host: HostRow) => {
    const api = cloudflare(env)
    if (host.dns_record_id) {
      await api.deleteRecord(host.dns_record_id)
      await env.DB.prepare("UPDATE host SET dns_record_id = NULL WHERE id = ?").bind(host.id).run()
    }
    if (host.tunnel_id) await api.deleteTunnel(host.tunnel_id)
    await env.DB.prepare("DELETE FROM host WHERE id = ?").bind(host.id).run()
  }

  app.onError((error, c) => {
    if (error instanceof CloudflareError) return c.json({ error: error.message }, 502)
    console.error("relay request failed", error)
    return c.json({ error: "The relay failed. Try again." }, 500)
  })

  app.post("/v1/links", async (c) => {
    const input = await body(c, NewLink)
    if (Option.isNone(input)) {
      return fail(c, 400, "Send environmentId (letters, digits and dashes) and name, each 1 to 64 characters.")
    }
    const now = deps.now()
    const deviceCode = toBase64Url(deps.random(32))
    const letters = Array.from(deps.random(8), (byte) => USER_CODE_ALPHABET[byte % USER_CODE_ALPHABET.length])
    const userCode = normalizeUserCode(letters.join(""))
    const expiresAt = now + LINK_TTL_MS
    await c.env.DB.batch([
      c.env.DB.prepare("DELETE FROM link WHERE expires_at <= ?").bind(now),
      c.env.DB.prepare(
        "INSERT INTO link (device_code_hash, user_code, environment_id, name, expires_at) VALUES (?, ?, ?, ?, ?)",
      ).bind(await sha256(deviceCode), userCode, input.value.environmentId, input.value.name, expiresAt),
    ])
    const url = new URL("/link", c.req.url)
    url.searchParams.set("code", userCode)
    return c.json({ deviceCode, userCode, url: url.href, interval: POLL_INTERVAL_S, expiresAt })
  })

  app.get("/link", (c) => {
    // A framed Approve button could be clicked through an overlay, linking someone else's machine.
    c.header("Content-Security-Policy", "frame-ancestors 'none'")
    c.header("X-Frame-Options", "DENY")
    return c.html(linkPage)
  })

  app.post("/v1/links/claim", async (c) => {
    const input = await body(c, Claim)
    if (Option.isNone(input)) return fail(c, 400, "Send the deviceCode from POST /v1/links.")
    const deviceCodeHash = await sha256(input.value.deviceCode)
    const link = await c.env.DB.prepare("SELECT * FROM link WHERE device_code_hash = ?")
      .bind(deviceCodeHash)
      .first<LinkRow>()
    const now = deps.now()
    if (!link || link.expires_at <= now) {
      await c.env.DB.prepare("DELETE FROM link WHERE device_code_hash = ?").bind(deviceCodeHash).run()
      return fail(c, 410, "The link code expired. Start linking again.")
    }
    if (!link.user_id) return c.json({ pending: true }, 202)

    // Deleting first lets only one of two concurrent claims through, so neither revokes the other's credential.
    const taken = await c.env.DB.prepare("DELETE FROM link WHERE device_code_hash = ?").bind(deviceCodeHash).run()
    if (taken.meta.changes === 0) return fail(c, 410, "The link code was already used. Start linking again.")

    const credential = toBase64Url(deps.random(32))
    // On a re-link the row keeps its id, tunnel and DNS record, and the new hash revokes the old credential.
    await c.env.DB.prepare(
      `INSERT INTO host (id, user_id, environment_id, name, credential_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (user_id, environment_id) DO UPDATE SET name = excluded.name, credential_hash = excluded.credential_hash`,
    )
      .bind(toHex(deps.random(8)), link.user_id, link.environment_id, link.name, await sha256(credential), now)
      .run()
    return c.json({ credential })
  })

  app.get("/v1/links/:userCode", async (c) => {
    if (!(await deps.verifyUser(c.req.raw, c.env))) return fail(c, 401, "Enter the owner token first.")
    const link = await pendingLink(c.env, c.req.param("userCode"))
    if (!link) return fail(c, 404, "This link code expired or does not exist. Start linking again in HinaCode.")
    return c.json({ name: link.name, environmentId: link.environment_id })
  })

  app.post("/v1/links/:userCode", async (c) => {
    const userId = await deps.verifyUser(c.req.raw, c.env)
    if (!userId) return fail(c, 401, "Enter the owner token first.")
    const link = await pendingLink(c.env, c.req.param("userCode"))
    if (!link) return fail(c, 404, "This link code expired or does not exist. Start linking again in HinaCode.")
    if (link.user_id && link.user_id !== userId) return fail(c, 409, "Another account already approved this machine.")
    const others = await c.env.DB.prepare(
      "SELECT COUNT(*) AS count FROM host WHERE user_id = ? AND environment_id != ?",
    )
      .bind(userId, link.environment_id)
      .first<number>("count")
    if ((others ?? 0) >= MAX_HOSTS) {
      return fail(c, 409, `Your account already has ${MAX_HOSTS} machines. Remove one to link ${link.name}.`)
    }
    await c.env.DB.prepare("UPDATE link SET user_id = ? WHERE device_code_hash = ?")
      .bind(userId, link.device_code_hash)
      .run()
    return c.body(null, 204)
  })

  app.put("/v1/tunnel", async (c) => {
    const host = await machine(c)
    if (!host) return fail(c, 401, "This machine is not linked. Link it again.")
    const input = await body(c, Tunnel)
    if (Option.isNone(input)) return fail(c, 400, "Send origin as http://<address>:<port>, with no path.")

    const api = cloudflare(c.env)
    const save = (column: "tunnel_id" | "dns_record_id", value: string) =>
      c.env.DB.prepare(`UPDATE host SET ${column} = ? WHERE id = ?`).bind(value, host.id).run()
    const hostname = hostnameOf(c.env, host)
    const tunnelName = `hinacode-${host.id}`

    const tunnelId = (await api.findTunnel(tunnelName)) ?? (await api.createTunnel(tunnelName))
    if (tunnelId !== host.tunnel_id) await save("tunnel_id", tunnelId)
    await api.putIngress(tunnelId, hostname, input.value.origin)

    const target = `${tunnelId}.cfargotunnel.com`
    const record = await api.findCname(hostname)
    const recordId = record?.id ?? (await api.createCname(hostname, target))
    if (record && record.content !== target) await api.updateCname(record.id, hostname, target)
    if (recordId !== host.dns_record_id) await save("dns_record_id", recordId)

    return c.json({ hostname, connectorToken: await api.tunnelToken(tunnelId) })
  })

  app.delete("/v1/host", async (c) => {
    const host = await machine(c)
    if (!host) return fail(c, 401, "This machine is not linked.")
    await removeHost(c.env, host)
    return c.body(null, 204)
  })

  app.put("/v1/host/pairing", async (c) => {
    const host = await machine(c)
    if (!host) return fail(c, 401, "This machine is not linked. Link it again.")
    const input = await body(c, Pairing)
    if (Option.isNone(input)) {
      return fail(
        c,
        400,
        "Send hosts (1 to 16 addresses without spaces, slashes, brackets or @), port (1 to 65535) and token (1 to 256 characters).",
      )
    }
    await c.env.DB.prepare("UPDATE host SET pairing = ? WHERE id = ?").bind(JSON.stringify(input.value), host.id).run()
    return c.body(null, 204)
  })

  app.get("/v1/machines", async (c) => {
    const userId = await deps.verifyUser(c.req.raw, c.env)
    if (!userId) return fail(c, 401, "Enter the owner token first.")
    const { results } = await c.env.DB.prepare(
      "SELECT * FROM host WHERE user_id = ? AND enabled = 1 AND pairing IS NOT NULL ORDER BY created_at, id",
    )
      .bind(userId)
      .all<HostRow>()
    const machines = results.flatMap((host) =>
      Option.match(Schema.decodeUnknownOption(StoredPairing)(host.pairing), {
        onNone: () => [],
        onSome: (pairing) => [
          {
            environmentId: host.environment_id,
            name: host.name,
            pairing: { ...pairing, relay: hostnameOf(c.env, host) },
          },
        ],
      }),
    )
    c.header("Cache-Control", "no-store")
    return c.json({ machines })
  })

  app.get("/v1/hosts", async (c) => {
    const userId = await deps.verifyUser(c.req.raw, c.env)
    if (!userId) return fail(c, 401, "Enter the owner token first.")
    const { results } = await c.env.DB.prepare("SELECT * FROM host WHERE user_id = ? ORDER BY created_at, id")
      .bind(userId)
      .all<HostRow>()
    return c.json({
      hosts: results.map((host) => ({
        id: host.id,
        environmentId: host.environment_id,
        name: host.name,
        hostname: hostnameOf(c.env, host),
        createdAt: host.created_at,
        enabled: host.enabled === 1,
        published: host.pairing !== null,
      })),
    })
  })

  app.patch("/v1/hosts/:id", async (c) => {
    const userId = await deps.verifyUser(c.req.raw, c.env)
    if (!userId) return fail(c, 401, "Enter the owner token first.")
    const input = await body(c, HostChange)
    if (Option.isNone(input)) return fail(c, 400, "Send enabled as true or false.")
    const changed = await c.env.DB.prepare("UPDATE host SET enabled = ? WHERE id = ? AND user_id = ?")
      .bind(input.value.enabled ? 1 : 0, c.req.param("id"), userId)
      .run()
    if (changed.meta.changes === 0) return fail(c, 404, "No machine with this id is linked to your account.")
    return c.body(null, 204)
  })

  app.delete("/v1/hosts/:id", async (c) => {
    const userId = await deps.verifyUser(c.req.raw, c.env)
    if (!userId) return fail(c, 401, "Enter the owner token first.")
    const host = await c.env.DB.prepare("SELECT * FROM host WHERE id = ? AND user_id = ?")
      .bind(c.req.param("id"), userId)
      .first<HostRow>()
    if (!host) return fail(c, 404, "No machine with this id is linked to your account.")
    await removeHost(c.env, host)
    return c.body(null, 204)
  })

  app.post("/v1/owner/token", async (c) => {
    if (!(await deps.verifyUser(c.req.raw, c.env))) return fail(c, 401, "Enter the owner token first.")
    const token = toBase64Url(deps.random(32))
    await c.env.DB.prepare(
      "INSERT INTO owner (id, token_hash) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET token_hash = excluded.token_hash",
    )
      .bind(await sha256(token))
      .run()
    return c.json({ token })
  })

  return app
}
