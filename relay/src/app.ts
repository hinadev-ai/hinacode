import { Option, Schema } from "effect"
import { Hono, type Context } from "hono"
import { cors } from "hono/cors"
import { CloudflareError, makeCloudflare, type Fetch } from "./cloudflare"
import { linkPage, signedInPage, signInPage } from "./page"
import { type Host, type Link, runStore } from "./store"

export type { Fetch } from "./cloudflare"

interface Deps {
  verifySession(request: Request, env: Env): Promise<string | null>
  accountProfile(
    userId: string,
    env: Env,
  ): Promise<{ name: string | null; email: string | null; imageUrl: string | null }>
  cloudflare: Fetch
  now(): number
  random(bytes: number): Uint8Array
}

type App = { Bindings: Env }

const LINK_TTL_MS = 10 * 60 * 1000
const SIGN_IN_CODE_TTL_MS = 2 * 60 * 1000
const POLL_INTERVAL_S = 5
const MAX_HOSTS = 5
const DEVICE_LINK_NEEDS_SESSION = "Approve this sign-in on the relay page in your browser."
const SIGN_IN_CODE_GONE = "The sign-in expired or was already used. Sign in again."
const ALREADY_DECIDED = "This request was already approved or denied."

const Label = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(64))
const NewLink = Schema.Struct({
  environmentId: Label.check(Schema.isPattern(/^[A-Za-z0-9-]+$/)),
  name: Label,
})
const NewSignIn = Schema.Struct({ name: Label })
const Claim = Schema.Struct({ deviceCode: Schema.String.check(Schema.isMaxLength(128)) })
const NewSignInCode = Schema.Struct({
  redirectUri: Schema.String.check(Schema.isMaxLength(2048)),
  codeChallenge: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{43}$/)),
  name: Label,
})
const SignInCodeExchange = Schema.Struct({
  code: Schema.String.check(Schema.isMaxLength(128)),
  codeVerifier: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9._~-]{43,128}$/)),
})
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

export const bearer = (request: Request) => /^Bearer (\S+)$/.exec(request.headers.get("Authorization") ?? "")?.[1]

const toHex = (bytes: Uint8Array) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")

const toBase64Url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "")

const digest = async (value: string) =>
  new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))

export const sha256 = async (value: string) => toHex(await digest(value))

const s256Challenge = async (verifier: string) => toBase64Url(await digest(verifier))

const APP_APPROVAL_PATH = "/oauth/signed-in"

const appRedirect = (redirectUri: string) => {
  if (!URL.canParse(redirectUri)) return null
  const url = new URL(redirectUri)
  if (url.search || url.hash) return null
  const loopback = url.protocol === "http:" && url.hostname === "127.0.0.1" && url.port !== ""
  return url.protocol === "hinacode:" || loopback ? url : null
}

const page = (c: Context, html: string) => {
  c.header("Content-Security-Policy", "frame-ancestors 'none'")
  c.header("X-Frame-Options", "DENY")
  return c.html(html)
}

const hostnameOf = (env: Env, host: Pick<Host, "id">) => `${host.id}.${env.TUNNEL_ZONE_NAME}`

const fail = (c: Context, status: 400 | 401 | 403 | 404 | 409 | 410, error: string) => c.json({ error }, status)

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

  const userOfDevice = async (c: Context<App>) => {
    const credential = bearer(c.req.raw)
    if (!credential) return null
    const credentialHash = await sha256(credential)
    const device = await runStore(c.env.DB, (store) => store.deviceByCredential(credentialHash))
    return Option.getOrNull(device)?.userId ?? null
  }

  const verifyUser = async (c: Context<App>) => (await userOfDevice(c)) ?? deps.verifySession(c.req.raw, c.env)

  const refusesDeviceLink = async (c: Context<App>, link: Link) =>
    link.kind === "device" && !(await deps.verifySession(c.req.raw, c.env))

  const machine = async (c: Context<App>) => {
    const credential = bearer(c.req.raw)
    if (!credential) return Option.none()
    const credentialHash = await sha256(credential)
    return runStore(c.env.DB, (store) => store.hostByCredential(credentialHash))
  }

  const pendingLink = (env: Env, userCode: string) =>
    runStore(env.DB, (store) => store.unexpiredLink({ userCode: userCode, now: deps.now() }))

  const removeHost = async (env: Env, host: Host) => {
    const api = cloudflare(env)
    if (host.dnsRecordId) {
      await api.deleteRecord(host.dnsRecordId)
      await runStore(env.DB, (store) => store.setDnsRecord(host.id, null))
    }
    if (host.tunnelId) await api.deleteTunnel(host.tunnelId)
    await runStore(env.DB, (store) => store.deleteHost(host.id))
  }

  app.use("/v1/*", (c, next) =>
    cors({ origin: c.env.WEB_ORIGINS.split(","), allowMethods: ["GET", "POST", "PATCH", "DELETE"], maxAge: 600 })(
      c,
      next,
    ),
  )

  app.onError((error, c) => {
    if (error instanceof CloudflareError) return c.json({ error: error.message }, 502)
    console.error("relay request failed", error)
    return c.json({ error: "The relay failed. Try again." }, 500)
  })

  const signInDevice = async (c: Context<App>, userId: string, name: string) => {
    const credential = toBase64Url(deps.random(32))
    const device = {
      id: toHex(deps.random(8)),
      userId,
      name,
      credentialHash: await sha256(credential),
      createdAt: deps.now(),
    }
    await runStore(c.env.DB, (store) => store.addDevice(device))
    return c.json({ credential })
  }

  const startLink = async (c: Context<App>, link: Pick<Link, "kind" | "environmentId" | "name">) => {
    const now = deps.now()
    const deviceCode = toBase64Url(deps.random(32))
    const userCode = toBase64Url(deps.random(16))
    const expiresAt = now + LINK_TTL_MS
    const deviceCodeHash = await sha256(deviceCode)
    await runStore(c.env.DB, (store) => store.createLink({ deviceCodeHash, userCode, ...link, expiresAt }, now))
    const url = new URL("/link", c.req.url)
    url.searchParams.set("code", userCode)
    return c.json({ deviceCode, userCode, url: url.href, interval: POLL_INTERVAL_S, expiresAt })
  }

  app.post("/v1/links", async (c) => {
    const input = await body(c, NewLink)
    if (Option.isNone(input)) {
      return fail(c, 400, "Send environmentId (letters, digits and dashes) and name, each 1 to 64 characters.")
    }
    return startLink(c, { kind: "machine", ...input.value })
  })

  app.post("/v1/sign-ins", async (c) => {
    const input = await body(c, NewSignIn)
    if (Option.isNone(input)) return fail(c, 400, "Send name, 1 to 64 characters.")
    return startLink(c, { kind: "device", environmentId: "", name: input.value.name })
  })

  app.get("/link", (c) => page(c, linkPage(c.env.CLERK_PUBLISHABLE_KEY)))

  app.post("/v1/links/claim", async (c) => {
    const input = await body(c, Claim)
    if (Option.isNone(input)) return fail(c, 400, "Send the deviceCode from POST /v1/links.")
    const deviceCodeHash = await sha256(input.value.deviceCode)
    const found = await runStore(c.env.DB, (store) => store.linkByDeviceCode(deviceCodeHash))
    const now = deps.now()
    if (Option.isNone(found) || found.value.expiresAt <= now) {
      await runStore(c.env.DB, (store) => store.deleteLink(deviceCodeHash))
      return fail(c, 410, "The link expired. Start linking again.")
    }
    const { userId, environmentId, name, kind, denied } = found.value
    if (denied) {
      await runStore(c.env.DB, (store) => store.deleteLink(deviceCodeHash))
      return fail(c, 403, "The request was denied in the browser.")
    }
    if (!userId) return c.json({ pending: true }, 202)

    const taken = await runStore(c.env.DB, (store) => store.deleteLink(deviceCodeHash))
    if (!taken) return fail(c, 410, "The link was already used. Start linking again.")

    if (kind === "device") return signInDevice(c, userId, name)
    const credential = toBase64Url(deps.random(32))
    const host = {
      id: toHex(deps.random(8)),
      userId,
      environmentId,
      name,
      credentialHash: await sha256(credential),
      createdAt: now,
    }
    await runStore(c.env.DB, (store) => store.linkHost(host))
    return c.json({ credential })
  })

  app.get("/sign-in", (c) => page(c, signInPage(c.env.CLERK_PUBLISHABLE_KEY)))

  app.get("/signed-in", (c) => page(c, signedInPage()))

  const ownMachineRedirect = async (env: Env, userId: string, redirectUri: string) => {
    if (!URL.canParse(redirectUri)) return null
    const url = new URL(redirectUri)
    if (url.protocol !== "https:" || url.port || url.search || url.hash || url.pathname !== APP_APPROVAL_PATH)
      return null
    const hosts = await runStore(env.DB, (store) => store.hostsOfUser(userId))
    const host = hosts.find((candidate) => hostnameOf(env, candidate) === url.hostname)
    return host === undefined ? null : { url, hostId: host.id }
  }

  app.post("/v1/sign-in-codes", async (c) => {
    const userId = await deps.verifySession(c.req.raw, c.env)
    if (!userId) return fail(c, 401, "Sign in first.")
    const input = await body(c, NewSignInCode)
    if (Option.isNone(input)) {
      return fail(c, 400, "Send redirectUri, codeChallenge (43 base64url characters) and name (1 to 64 characters).")
    }
    const appUrl = appRedirect(input.value.redirectUri)
    const target = appUrl
      ? { url: appUrl, hostId: null }
      : await ownMachineRedirect(c.env, userId, input.value.redirectUri)
    if (!target) {
      return fail(
        c,
        400,
        `Send redirectUri as http://127.0.0.1:<port>/<path>, hinacode://<path> or https://<one of your machines>${APP_APPROVAL_PATH}, with no query or fragment.`,
      )
    }
    const redirectUrl = target.url
    const now = deps.now()
    const code = toBase64Url(deps.random(32))
    const signInCode = {
      codeHash: await sha256(code),
      codeChallenge: input.value.codeChallenge,
      userId,
      name: input.value.name,
      expiresAt: now + SIGN_IN_CODE_TTL_MS,
      hostId: target.hostId,
    }
    await runStore(c.env.DB, (store) => store.createSignInCode(signInCode, now))
    redirectUrl.searchParams.set("code", code)
    return c.json({ redirectUrl: redirectUrl.href })
  })

  const takeSignInCode = async (c: Context<App>, input: typeof SignInCodeExchange.Type) => {
    const codeHash = await sha256(input.code)
    const taken = await runStore(c.env.DB, (store) => store.takeSignInCode(codeHash))
    if (Option.isNone(taken) || taken.value.expiresAt <= deps.now()) return null
    return (await s256Challenge(input.codeVerifier)) === taken.value.codeChallenge ? taken.value : null
  }

  app.post("/v1/sign-in-codes/exchange", async (c) => {
    const input = await body(c, SignInCodeExchange)
    if (Option.isNone(input)) return fail(c, 400, "Send code and codeVerifier (43 to 128 characters).")
    const taken = await takeSignInCode(c, input.value)
    if (taken === null || taken.hostId !== null) return fail(c, 410, SIGN_IN_CODE_GONE)
    return signInDevice(c, taken.userId, taken.name)
  })

  app.post("/v1/host/sign-in-codes/verify", async (c) => {
    const host = await machine(c)
    if (Option.isNone(host)) return fail(c, 401, "This machine is not linked.")
    const input = await body(c, SignInCodeExchange)
    if (Option.isNone(input)) return fail(c, 400, "Send code and codeVerifier (43 to 128 characters).")
    const taken = await takeSignInCode(c, input.value)
    if (taken === null || taken.hostId !== host.value.id || taken.userId !== host.value.userId) {
      return fail(c, 410, SIGN_IN_CODE_GONE)
    }
    const { name, email } = await deps.accountProfile(taken.userId, c.env)
    return c.json({ name, email })
  })

  app.get("/v1/links/:userCode", async (c) => {
    if (!(await verifyUser(c))) return fail(c, 401, "Sign in first.")
    const link = await pendingLink(c.env, c.req.param("userCode"))
    if (Option.isNone(link)) {
      return fail(c, 404, "This link expired or does not exist. Start linking again in HinaCode.")
    }
    if (await refusesDeviceLink(c, link.value)) return fail(c, 403, DEVICE_LINK_NEEDS_SESSION)
    return c.json({ kind: link.value.kind, name: link.value.name, environmentId: link.value.environmentId })
  })

  app.post("/v1/links/:userCode", async (c) => {
    const userId = await verifyUser(c)
    if (!userId) return fail(c, 401, "Sign in first.")
    const found = await pendingLink(c.env, c.req.param("userCode"))
    if (Option.isNone(found)) {
      return fail(c, 404, "This link expired or does not exist. Start linking again in HinaCode.")
    }
    const link = found.value
    if (link.userId && link.userId !== userId) return fail(c, 409, "Another account already approved this machine.")
    if (await refusesDeviceLink(c, link)) return fail(c, 403, DEVICE_LINK_NEEDS_SESSION)
    if (link.kind === "machine") {
      const others = await runStore(c.env.DB, (store) => store.countOtherHosts(userId, link.environmentId))
      if (others >= MAX_HOSTS) {
        return fail(c, 409, `Your account already has ${MAX_HOSTS} machines. Remove one to link ${link.name}.`)
      }
    }
    const approved = await runStore(c.env.DB, (store) => store.approveLink(link.deviceCodeHash, userId))
    if (!approved) return fail(c, 409, ALREADY_DECIDED)
    return c.body(null, 204)
  })

  app.delete("/v1/links/:userCode", async (c) => {
    const userId = await verifyUser(c)
    if (!userId) return fail(c, 401, "Sign in first.")
    const found = await pendingLink(c.env, c.req.param("userCode"))
    if (Option.isNone(found)) {
      return fail(c, 404, "This link expired or does not exist. Start linking again in HinaCode.")
    }
    const link = found.value
    if (await refusesDeviceLink(c, link)) return fail(c, 403, DEVICE_LINK_NEEDS_SESSION)
    const denied = await runStore(c.env.DB, (store) => store.denyLink(link.deviceCodeHash))
    return denied ? c.body(null, 204) : fail(c, 409, ALREADY_DECIDED)
  })

  app.put("/v1/tunnel", async (c) => {
    const found = await machine(c)
    if (Option.isNone(found)) return fail(c, 401, "This machine is not linked. Link it again.")
    const host = found.value
    const input = await body(c, Tunnel)
    if (Option.isNone(input)) return fail(c, 400, "Send origin as http://<address>:<port>, with no path.")

    const api = cloudflare(c.env)
    const hostname = hostnameOf(c.env, host)
    const tunnelName = `hinacode-${host.id}`

    const tunnelId = (await api.findTunnel(tunnelName)) ?? (await api.createTunnel(tunnelName))
    if (tunnelId !== host.tunnelId) await runStore(c.env.DB, (store) => store.setTunnel(host.id, tunnelId))
    await api.putIngress(tunnelId, hostname, input.value.origin)

    const target = `${tunnelId}.cfargotunnel.com`
    const record = await api.findCname(hostname)
    const recordId = record?.id ?? (await api.createCname(hostname, target))
    if (record && record.content !== target) await api.updateCname(record.id, hostname, target)
    if (recordId !== host.dnsRecordId) await runStore(c.env.DB, (store) => store.setDnsRecord(host.id, recordId))

    return c.json({ hostname, connectorToken: await api.tunnelToken(tunnelId) })
  })

  app.delete("/v1/host", async (c) => {
    const host = await machine(c)
    if (Option.isNone(host)) return fail(c, 401, "This machine is not linked.")
    await removeHost(c.env, host.value)
    return c.body(null, 204)
  })

  app.put("/v1/host/pairing", async (c) => {
    const host = await machine(c)
    if (Option.isNone(host)) return fail(c, 401, "This machine is not linked. Link it again.")
    const input = await body(c, Pairing)
    if (Option.isNone(input)) {
      return fail(
        c,
        400,
        "Send hosts (1 to 16 addresses without spaces, slashes, brackets or @), port (1 to 65535) and token (1 to 256 characters).",
      )
    }
    await runStore(c.env.DB, (store) => store.setPairing(host.value.id, JSON.stringify(input.value)))
    return c.body(null, 204)
  })

  app.get("/v1/machines", async (c) => {
    const userId = await verifyUser(c)
    if (!userId) return fail(c, 401, "Sign in first.")
    const hosts = await runStore(c.env.DB, (store) => store.shownHostsOfUser(userId))
    const machines = hosts.flatMap((host) =>
      Option.match(Schema.decodeUnknownOption(StoredPairing)(host.pairing), {
        onNone: () => [],
        onSome: (pairing) => [
          {
            environmentId: host.environmentId,
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
    const userId = await verifyUser(c)
    if (!userId) return fail(c, 401, "Sign in first.")
    const hosts = await runStore(c.env.DB, (store) => store.hostsOfUser(userId))
    return c.json({
      hosts: hosts.map((host) => ({
        id: host.id,
        environmentId: host.environmentId,
        name: host.name,
        hostname: hostnameOf(c.env, host),
        createdAt: host.createdAt,
        enabled: host.enabled,
        published: host.pairing !== null,
      })),
    })
  })

  app.patch("/v1/hosts/:id", async (c) => {
    const userId = await verifyUser(c)
    if (!userId) return fail(c, 401, "Sign in first.")
    const input = await body(c, HostChange)
    if (Option.isNone(input)) return fail(c, 400, "Send enabled as true or false.")
    const host = { id: c.req.param("id"), userId }
    const changed = await runStore(c.env.DB, (store) => store.setShown(host, input.value.enabled))
    if (!changed) return fail(c, 404, "No machine with this id is linked to your account.")
    return c.body(null, 204)
  })

  app.delete("/v1/hosts/:id", async (c) => {
    const userId = await verifyUser(c)
    if (!userId) return fail(c, 401, "Sign in first.")
    const host = await runStore(c.env.DB, (store) => store.hostOfUser({ id: c.req.param("id"), userId }))
    if (Option.isNone(host)) return fail(c, 404, "No machine with this id is linked to your account.")
    await removeHost(c.env, host.value)
    return c.body(null, 204)
  })

  app.get("/v1/account", async (c) => {
    const userId = await verifyUser(c)
    if (!userId) return fail(c, 401, "Sign in first.")
    return c.json(await deps.accountProfile(userId, c.env))
  })

  app.delete("/v1/device", async (c) => {
    const credential = bearer(c.req.raw)
    if (!credential) return fail(c, 401, "Sign in first.")
    const credentialHash = await sha256(credential)
    const deleted = await runStore(c.env.DB, (store) => store.deleteDeviceByCredential(credentialHash))
    return deleted ? c.body(null, 204) : fail(c, 401, "Sign in first.")
  })

  app.get("/v1/config", (c) => c.json({ clerkPublishableKey: c.env.CLERK_PUBLISHABLE_KEY }))

  app.post("/v1/devices", async (c) => {
    const userId = await deps.verifySession(c.req.raw, c.env)
    if (!userId) return fail(c, 401, "Sign in first.")
    const input = await body(c, NewSignIn)
    if (Option.isNone(input)) return fail(c, 400, "Send name, 1 to 64 characters.")
    return signInDevice(c, userId, input.value.name)
  })

  app.delete("/v1/devices", async (c) => {
    const userId = await deps.verifySession(c.req.raw, c.env)
    if (!userId) return fail(c, 401, "Sign in first.")
    await runStore(c.env.DB, (store) => store.deleteDevicesOfUser(userId))
    return c.body(null, 204)
  })

  return app
}
