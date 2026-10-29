import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { NodeServices } from "@effect/platform-node"
import { afterAll, describe, expect, it } from "@effect/vitest"
import { vi } from "vitest"
import { Cause, Effect, Exit, Fiber, Layer, Option, Stream } from "effect"
import { SqlClient } from "effect/sql"
import { TestClock } from "effect/testing"
import type { RelayStatus } from "../../shared/domain.ts"
import * as Db from "../db/client.ts"
import * as SecretsModule from "../services/Secrets.ts"
import { Secrets } from "../services/Secrets.ts"
import * as SettingsModule from "../services/Settings.ts"
import { Settings } from "../services/Settings.ts"
import * as RemoteAccessModule from "./access.ts"
import { RemoteAccess } from "./access.ts"
import { applyServeRelay } from "../serve.ts"
import { CLOUDFLARED_VERSION } from "./cloudflared.ts"
import * as RelayModule from "./relay.ts"
import { CONNECTOR_TOKEN_SECRET, CREDENTIAL_SECRET, Relay, type RelayTunnel, storedTunnel } from "./relay.ts"
import type { Fetch, RelayLink } from "./relayService.ts"

const HOSTNAME = "3f9c2a1b7d4e5f60.hinacode.app"
const PORT = 48123
const ORIGIN = `http://127.0.0.1:${PORT}`
const SERVICE_URL = "https://relay.test"
const LINK_URL = "https://relay.test/link?code=WXYZ-2345"

const tunnel: RelayTunnel = { hostname: HOSTNAME, origin: ORIGIN }

const REGISTERED = 'echo "2026-10-24T00:00:00Z INF Registered tunnel connection connIndex=0" >&2'
const FAILED = 'echo "2026-10-24T00:00:00Z ERR Unauthorized: Invalid tunnel secret" >&2; exit 1'

const standIns = mkdtempSync(join(tmpdir(), "hinacode-cloudflared-"))
afterAll(() => rmSync(standIns, { recursive: true, force: true }))

const standIn = (body: string) => {
  const dir = mkdtempSync(join(standIns, "run-"))
  const path = join(dir, "cloudflared")
  writeFileSync(
    path,
    [
      "#!/bin/sh",
      'dir=$(dirname "$0")',
      'printf "%s" "$TUNNEL_TOKEN" > "$dir/token"',
      'printf "%s" "$*" > "$dir/args"',
      'echo $$ > "$dir/pid"',
      body,
    ].join("\n"),
  )
  chmodSync(path, 0o755)
  return { path, read: (name: string) => readFileSync(join(dir, name), "utf8").trim() }
}

const connects = () => standIn(`${REGISTERED}\nexec sleep 3600`)

const ASSET_URL = "https://downloads.test/cloudflared-darwin-arm64.tgz"

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")

const tarball = (body: string) => {
  const dir = standIn(body).path.replace(/\/cloudflared$/, "")
  execFileSync("tar", ["-czf", join(dir, "release.tgz"), "-C", dir, "cloudflared"])
  return readFileSync(join(dir, "release.tgz"))
}

const serves =
  (archive: Uint8Array): Fetch =>
  async (url) =>
    url.href === ASSET_URL ? new Response(new Uint8Array(archive)) : new Response(null, { status: 404 })

const unexpected: Fetch = () => Promise.reject(new Error("no relay service call expected"))

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

interface ServiceCall {
  readonly call: string
  readonly body: unknown
  readonly credential: string | null
}

const fakeService = (
  options: {
    pendingClaims?: number
    expiresAt?: number
    claimStatus?: number
    deleteStatus?: number
    tunnelNeverAnswers?: boolean
  } = {},
) => {
  const calls: Array<ServiceCall> = []
  let pending = options.pendingClaims ?? 0
  const fetch: Fetch = async (url, init) => {
    const call = `${init.method} ${url.pathname}`
    const authorization = new Headers(init.headers).get("Authorization")
    calls.push({
      call,
      body: init.body === undefined ? undefined : JSON.parse(String(init.body)),
      credential: authorization?.replace("Bearer ", "") ?? null,
    })
    if (call === "POST /v1/links") {
      return json({
        deviceCode: "device-1",
        userCode: "WXYZ-2345",
        url: LINK_URL,
        interval: 5,
        expiresAt: options.expiresAt ?? 3_600_000,
      })
    }
    if (call === "POST /v1/links/claim") {
      if (options.claimStatus !== undefined) return json({ error: "The link code expired." }, options.claimStatus)
      if (pending-- > 0) return json({ pending: true }, 202)
      return json({ credential: "credential-1" })
    }
    if (call === "PUT /v1/tunnel") {
      if (options.tunnelNeverAnswers) return new Promise<Response>(() => {})
      return json({ hostname: HOSTNAME, connectorToken: "connector-secret" })
    }
    if (call === "DELETE /v1/host") return new Response(null, { status: options.deleteStatus ?? 204 })
    if (call === "PUT /v1/host/pairing") return new Response(null, { status: 204 })
    return json({ error: `No route for ${call}` }, 404)
  }
  return {
    fetch,
    calls,
    claims: () => calls.filter(({ call }) => call === "POST /v1/links/claim").length,
    pairings: () => calls.filter(({ call }) => call === "PUT /v1/host/pairing"),
  }
}

const advanceUntil = (done: () => boolean) =>
  Effect.gen(function* () {
    for (let step = 0; step < 200 && !done(); step++) {
      yield* TestClock.adjust("1 second")
      yield* Effect.yieldNow
    }
    expect(done()).toBe(true)
  })

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const base = RemoteAccessModule.layer.pipe(
  Layer.provideMerge(SecretsModule.layer),
  Layer.provideMerge(Layer.suspend(() => SettingsModule.layer(mkdtempSync(join(tmpdir(), "kk-relay-settings-"))))),
  Layer.provideMerge(Db.layer(":memory:")),
  Layer.provide(Layer.mergeAll(NodeServices.layer, SecretsModule.noKeyring)),
)

const remoteOn = Settings.use((settings) =>
  settings.set({ remote: { enabled: true, bindHost: "127.0.0.1", port: PORT } }),
)

const linkedBefore = Secrets.use((secrets) => secrets.set(CREDENTIAL_SECRET, "credential-1"))

const currentPairing = Effect.gen(function* () {
  const { hosts, port, token } = yield* RemoteAccess.use((access) => access.pairing)
  const body = { hosts, port, token }
  return { body, fingerprint: sha256(Buffer.from(JSON.stringify(body))) }
})

const seed = (stored: Partial<RelayTunnel> = {}) =>
  Effect.gen(function* () {
    yield* remoteOn
    const row = { ...tunnel, published: (yield* currentPairing).fingerprint, ...stored }
    const sql = yield* SqlClient.SqlClient
    yield* sql`INSERT INTO setting (key, value) VALUES ('relay.tunnel', ${JSON.stringify(row)})`
    yield* Secrets.use((secrets) => secrets.set(CONNECTOR_TOKEN_SECRET, "connector-secret"))
    yield* linkedBefore
  })

const published = (fingerprint: string) =>
  Effect.gen(function* () {
    const services = yield* Effect.context<SqlClient.SqlClient>()
    const stored = () => Effect.runPromise(Effect.provide(storedTunnel, services))
    yield* Effect.promise(() => vi.waitFor(async () => expect((await stored())?.published).toBe(fingerprint)))
  })

const noLink = () => Effect.void

const until = (predicate: (status: RelayStatus) => boolean) =>
  Relay.use((relay) => relay.changes.pipe(Stream.filter(predicate), Stream.runHead, Effect.map(Option.getOrThrow)))

const withRelay = <A, E>(
  options: RelayModule.RelayOptions,
  effect: Effect.Effect<A, E, Relay | RemoteAccess | Settings | Secrets | SqlClient.SqlClient>,
) => effect.pipe(Effect.provide(RelayModule.layer(options)))

describe("Relay", () => {
  it.live("connects with the token in the environment, and pairings carry the hostname", () =>
    Effect.gen(function* () {
      yield* seed()
      const cloudflared = connects()
      yield* withRelay(
        { cloudflared: cloudflared.path },
        Effect.gen(function* () {
          const first = yield* Relay.use((relay) => relay.status)
          expect(first).toStrictEqual({ state: "connecting", hostname: HOSTNAME, error: null })
          yield* until((status) => status.state === "connected")

          expect(cloudflared.read("token")).toBe("connector-secret")
          expect(cloudflared.read("args")).toBe("tunnel --no-autoupdate --metrics 127.0.0.1:0 run")
          const access = yield* RemoteAccess
          expect((yield* access.status).relay).toStrictEqual({ state: "connected", hostname: HOSTNAME })
          expect((yield* access.pairing).relay).toBe(HOSTNAME)
        }),
      )
    }).pipe(Effect.provide(base)),
  )

  it.live("pauses and stops cloudflared when remote control is turned off", () =>
    Effect.gen(function* () {
      yield* seed()
      const cloudflared = connects()
      yield* withRelay(
        { cloudflared: cloudflared.path },
        Effect.gen(function* () {
          yield* until((status) => status.state === "connected")
          const pid = Number(cloudflared.read("pid"))

          yield* Settings.use((settings) =>
            settings.set({ remote: { enabled: false, bindHost: "127.0.0.1", port: PORT } }),
          )
          yield* until((status) => status.state === "paused")
          yield* Effect.promise(() => vi.waitFor(() => expect(isAlive(pid)).toBe(false)))
          expect((yield* RemoteAccess.use((access) => access.pairing)).relay).toBe(HOSTNAME)
        }),
      )
    }).pipe(Effect.provide(base)),
  )

  it.effect("reports the last error when cloudflared exits, and restarts it after a second", () =>
    Effect.gen(function* () {
      yield* seed()
      const cloudflared = standIn(
        `if [ -f "$dir/ran" ]; then ${REGISTERED}; exec sleep 3600; fi\ntouch "$dir/ran"\n${FAILED}`,
      )
      yield* withRelay(
        { cloudflared: cloudflared.path },
        Effect.gen(function* () {
          const failed = yield* until((status) => status.state === "connecting" && status.error !== null)
          expect(failed).toStrictEqual({
            state: "connecting",
            hostname: HOSTNAME,
            error: "Unauthorized: Invalid tunnel secret",
          })
          yield* TestClock.adjust("1 second")
          yield* until((status) => status.state === "connected")
        }),
      )
    }).pipe(Effect.provide(base)),
  )

  it.live("names the exit code when cloudflared says nothing", () =>
    Effect.gen(function* () {
      yield* seed()
      const cloudflared = standIn("exit 3")
      yield* withRelay(
        { cloudflared: cloudflared.path },
        until((status) => status.state === "connecting" && status.error === "cloudflared exited with code 3"),
      )
    }).pipe(Effect.provide(base)),
  )

  it.live("downloads cloudflared when it is not installed, checks it and connects through it", () =>
    Effect.gen(function* () {
      yield* seed()
      const archive = tarball(`${REGISTERED}\nexec sleep 3600`)
      const dir = mkdtempSync(join(standIns, "bin-"))
      yield* withRelay(
        {
          cloudflared: join(tmpdir(), "no-such-dir", "cloudflared"),
          fetch: serves(archive),
          cloudflaredDir: dir,
          cloudflaredAsset: { url: ASSET_URL, sha256: sha256(archive), archive: "tgz" },
        },
        Effect.gen(function* () {
          yield* until((status) => status.state === "connected")
          expect(readdirSync(dir)).toStrictEqual([CLOUDFLARED_VERSION])
        }),
      )
    }).pipe(Effect.provide(base)),
  )

  it.live("refuses a downloaded cloudflared whose checksum does not match", () =>
    Effect.gen(function* () {
      yield* seed()
      const archive = tarball(`${REGISTERED}\nexec sleep 3600`)
      const dir = mkdtempSync(join(standIns, "bin-"))
      yield* withRelay(
        {
          cloudflared: join(tmpdir(), "no-such-dir", "cloudflared"),
          fetch: serves(archive),
          cloudflaredDir: dir,
          cloudflaredAsset: { url: ASSET_URL, sha256: "0".repeat(64), archive: "tgz" },
        },
        Effect.gen(function* () {
          const failed = yield* until((status) => status.state === "connecting" && status.error !== null)
          expect(failed).toStrictEqual({
            state: "connecting",
            hostname: HOSTNAME,
            error: "Cannot install cloudflared: the download does not match its checksum.",
          })
          expect(readdirSync(dir)).toStrictEqual([])
        }),
      )
    }).pipe(Effect.provide(base)),
  )

  it.effect("links through the browser, claiming until the owner approves, then connects", () =>
    Effect.gen(function* () {
      yield* remoteOn
      const service = fakeService({ pendingClaims: 2 })
      const links: Array<RelayLink> = []
      yield* withRelay(
        { serviceUrl: SERVICE_URL, fetch: service.fetch, cloudflared: connects().path },
        Effect.gen(function* () {
          const setup = yield* Relay.use((relay) =>
            relay.setup({ onLink: (link) => Effect.sync(() => void links.push(link)) }),
          ).pipe(Effect.forkChild)
          expect(yield* until((status) => status.state === "linking")).toStrictEqual({
            state: "linking",
            url: LINK_URL,
            userCode: "WXYZ-2345",
          })
          expect(service.calls[0]).toMatchObject({
            call: "POST /v1/links",
            body: { environmentId: (yield* RemoteAccess).identity.id },
          })

          yield* advanceUntil(() => service.claims() === 3)
          yield* Fiber.join(setup)
          expect(links).toStrictEqual([{ url: LINK_URL, userCode: "WXYZ-2345" }])
          yield* until((status) => status.state === "connected")
          yield* advanceUntil(() => service.pairings().length === 1)
          expect(service.calls.map(({ call }) => call)).toStrictEqual([
            "POST /v1/links",
            "POST /v1/links/claim",
            "POST /v1/links/claim",
            "POST /v1/links/claim",
            "PUT /v1/tunnel",
            "PUT /v1/host/pairing",
          ])
          expect(service.calls[4]).toMatchObject({ body: { origin: ORIGIN }, credential: "credential-1" })
          expect((yield* RemoteAccess.use((access) => access.pairing)).relay).toBe(HOSTNAME)
          const { fingerprint } = yield* currentPairing
          yield* published(fingerprint)
          expect(yield* storedTunnel).toStrictEqual({ ...tunnel, published: fingerprint })
        }),
      )
    }).pipe(Effect.provide(base)),
  )

  it.effect("fails and turns off when the sign-in link expires", () =>
    Effect.gen(function* () {
      yield* remoteOn
      const service = fakeService({ claimStatus: 410 })
      yield* withRelay(
        { serviceUrl: SERVICE_URL, fetch: service.fetch, cloudflared: connects().path },
        Effect.gen(function* () {
          const setup = yield* Relay.use((relay) => relay.setup({ onLink: noLink })).pipe(Effect.forkChild)
          yield* until((status) => status.state === "linking")
          yield* advanceUntil(() => service.claims() === 1)
          const failure = yield* Effect.flip(Fiber.join(setup))
          expect(failure.message).toBe("The sign-in link expired. Turn on the relay again.")
          expect(yield* Relay.use((relay) => relay.status)).toStrictEqual({ state: "off" })
        }),
      )
    }).pipe(Effect.provide(base)),
  )

  it.effect("stops claiming once the link is past its expiry", () =>
    Effect.gen(function* () {
      yield* remoteOn
      const service = fakeService({ expiresAt: 3000 })
      yield* withRelay(
        { serviceUrl: SERVICE_URL, fetch: service.fetch, cloudflared: connects().path },
        Effect.gen(function* () {
          const setup = yield* Relay.use((relay) => relay.setup({ onLink: noLink })).pipe(Effect.forkChild)
          yield* until((status) => status.state === "linking")
          yield* advanceUntil(() => setup.pollUnsafe() !== undefined)
          const failure = yield* Effect.flip(Fiber.join(setup))
          expect(failure.message).toBe("The sign-in link expired. Turn on the relay again.")
          expect(service.claims()).toBe(0)
        }),
      )
    }).pipe(Effect.provide(base)),
  )

  it.effect("removal cancels a pending link without waiting for it", () =>
    Effect.gen(function* () {
      yield* remoteOn
      const service = fakeService({ pendingClaims: 1000 })
      yield* withRelay(
        { serviceUrl: SERVICE_URL, fetch: service.fetch, cloudflared: connects().path },
        Effect.gen(function* () {
          const setup = yield* Relay.use((relay) => relay.setup({ onLink: noLink })).pipe(Effect.forkChild)
          yield* until((status) => status.state === "linking")
          yield* Relay.use((relay) => relay.remove)
          expect(Exit.isSuccess(yield* Fiber.await(setup))).toBe(false)
          expect(yield* Relay.use((relay) => relay.status)).toStrictEqual({ state: "off" })
          expect(service.calls.map(({ call }) => call)).toStrictEqual(["POST /v1/links"])
        }),
      )
    }).pipe(Effect.provide(base)),
  )

  it.effect("gives up on a relay service that never answers, so removal is not held up", () =>
    Effect.gen(function* () {
      yield* remoteOn
      yield* linkedBefore
      const service = fakeService({ tunnelNeverAnswers: true })
      yield* withRelay(
        { serviceUrl: SERVICE_URL, fetch: service.fetch, cloudflared: connects().path },
        Effect.gen(function* () {
          let settled = false
          const setup = yield* Relay.use((relay) => relay.setup({ onLink: noLink })).pipe(
            Effect.ensuring(Effect.sync(() => void (settled = true))),
            Effect.forkChild,
          )
          yield* advanceUntil(() => settled)
          const exit = yield* Fiber.await(setup)
          expect(Exit.isFailure(exit) && String(Cause.squash(exit.cause))).toContain("did not answer within 30 seconds")
          yield* Relay.use((relay) => relay.remove)
          expect(yield* Relay.use((relay) => relay.status)).toStrictEqual({ state: "off" })
        }),
      )
    }).pipe(Effect.provide(base)),
  )

  it.live("a linked machine routes its tunnel and publishes its pairing without signing in", () =>
    Effect.gen(function* () {
      yield* remoteOn
      yield* linkedBefore
      const service = fakeService()
      yield* withRelay(
        { serviceUrl: SERVICE_URL, fetch: service.fetch, cloudflared: connects().path },
        Effect.gen(function* () {
          yield* Relay.use((relay) => relay.setup({ onLink: () => Effect.die("no link expected") }))
          yield* until((status) => status.state === "connected")
          const { body, fingerprint } = yield* currentPairing
          yield* published(fingerprint)
          expect(service.calls).toStrictEqual([
            { call: "PUT /v1/tunnel", body: { origin: ORIGIN }, credential: "credential-1" },
            { call: "PUT /v1/host/pairing", body, credential: "credential-1" },
          ])
        }),
      )
    }).pipe(Effect.provide(base)),
  )

  it.live("routes the tunnel to the listener's new address before starting cloudflared", () =>
    Effect.gen(function* () {
      yield* seed({ origin: "http://127.0.0.1:1" })
      const service = fakeService()
      yield* withRelay(
        { serviceUrl: SERVICE_URL, fetch: service.fetch, cloudflared: connects().path },
        Effect.gen(function* () {
          yield* until((status) => status.state === "connected")
          expect(service.calls).toStrictEqual([
            { call: "PUT /v1/tunnel", body: { origin: ORIGIN }, credential: "credential-1" },
          ])
          expect(yield* storedTunnel).toStrictEqual({ ...tunnel, published: (yield* currentPairing).fingerprint })
        }),
      )
    }).pipe(Effect.provide(base)),
  )

  it.live.each([204, 401])("removal unlinks the machine and clears its tunnel when the service answers %d", (status) =>
    Effect.gen(function* () {
      yield* seed()
      const service = fakeService({ deleteStatus: status })
      yield* withRelay(
        { serviceUrl: SERVICE_URL, fetch: service.fetch, cloudflared: connects().path },
        Effect.gen(function* () {
          yield* Relay.use((relay) => relay.remove)
          expect(service.calls).toStrictEqual([
            { call: "DELETE /v1/host", body: undefined, credential: "credential-1" },
          ])
          expect(yield* Relay.use((relay) => relay.status)).toStrictEqual({ state: "off" })
          expect(yield* storedTunnel).toBeNull()
          expect(yield* Secrets.use((secrets) => secrets.has(CONNECTOR_TOKEN_SECRET))).toBe(false)
          expect(yield* Secrets.use((secrets) => secrets.has(CREDENTIAL_SECRET))).toBe(false)
          expect((yield* RemoteAccess.use((access) => access.pairing)).relay).toBeNull()
        }),
      )
    }).pipe(Effect.provide(base)),
  )

  it.effect("publishes the pairing once linked through the browser, and again after the token rotates", () =>
    Effect.gen(function* () {
      yield* remoteOn
      const service = fakeService()
      yield* withRelay(
        { serviceUrl: SERVICE_URL, fetch: service.fetch, cloudflared: connects().path },
        Effect.gen(function* () {
          const setup = yield* Relay.use((relay) => relay.setup({ onLink: noLink })).pipe(Effect.forkChild)
          yield* advanceUntil(() => service.pairings().length === 1)
          yield* Fiber.join(setup)
          const linked = yield* currentPairing
          expect(service.pairings()).toStrictEqual([
            { call: "PUT /v1/host/pairing", body: linked.body, credential: "credential-1" },
          ])
          yield* published(linked.fingerprint)

          const { token } = yield* RemoteAccess.use((access) => access.rotateToken)
          yield* advanceUntil(() => service.pairings().length === 2)
          expect(service.pairings()[1]).toStrictEqual({
            call: "PUT /v1/host/pairing",
            body: { ...linked.body, token },
            credential: "credential-1",
          })
          yield* published((yield* currentPairing).fingerprint)
        }),
      )
    }).pipe(Effect.provide(base)),
  )

  it.live("a booting machine whose pairing is already published makes no service call", () =>
    Effect.gen(function* () {
      yield* seed()
      const service = fakeService()
      yield* withRelay(
        { serviceUrl: SERVICE_URL, fetch: service.fetch, cloudflared: connects().path },
        until((status) => status.state === "connected"),
      )
      expect(service.calls).toStrictEqual([])
    }).pipe(Effect.provide(base)),
  )

  it.live("a booting machine whose published pairing is stale publishes it once and connects", () =>
    Effect.gen(function* () {
      yield* seed({ published: "stale" })
      const service = fakeService()
      yield* withRelay(
        { serviceUrl: SERVICE_URL, fetch: service.fetch, cloudflared: connects().path },
        Effect.gen(function* () {
          yield* until((status) => status.state === "connected")
          const { body, fingerprint } = yield* currentPairing
          yield* published(fingerprint)
          expect(service.calls).toStrictEqual([{ call: "PUT /v1/host/pairing", body, credential: "credential-1" }])
        }),
      )
    }).pipe(Effect.provide(base)),
  )

  it.live("serve --relay on keeps a relay that has a hostname without calling the service", () =>
    Effect.gen(function* () {
      yield* seed()
      yield* withRelay(
        { serviceUrl: SERVICE_URL, fetch: unexpected, cloudflared: connects().path },
        applyServeRelay("on", () => Effect.die("no link expected")),
      )
    }).pipe(Effect.provide(base)),
  )
})
