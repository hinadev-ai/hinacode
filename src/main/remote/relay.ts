import { spawn } from "node:child_process"
import { createInterface } from "node:readline"
import {
  Clock,
  Context,
  Duration,
  Effect,
  Equal,
  Exit,
  Fiber,
  FiberHandle,
  Layer,
  Option,
  Queue,
  Schema,
  Semaphore,
  Stream,
  SubscriptionRef,
} from "effect"
import { SqlClient, SqlSchema } from "effect/sql"
import type { RelayStatus, Settings as SettingsValue } from "../../shared/domain.ts"
import { type PersistenceError, persistence } from "../services/errors.ts"
import { Secrets } from "../services/Secrets.ts"
import { Settings } from "../services/Settings.ts"
import { RemoteAccess } from "./access.ts"
import { EXPIRED, type Fetch, type Link, RelayError, type RelayLink, relayService } from "./relayService.ts"

const TUNNEL_KEY = "relay.tunnel"
export const CREDENTIAL_SECRET = "relay.credential"
export const CONNECTOR_TOKEN_SECRET = "relay.connectorToken"

export const DEFAULT_RELAY_SERVICE_URL = "https://relay.hinacode.app"

const FIRST_RETRY_MS = 1000
const LAST_RETRY_MS = 60_000
/** A `cloudflared` that stayed up this long restarts after the first delay again. */
const HEALTHY_MS = 60_000

const CLOUDFLARED_ARGS = ["tunnel", "--no-autoupdate", "--metrics", "127.0.0.1:0", "run"]

/** Where `cloudflared` forwards to: the listener's own address, or loopback when it binds every interface. */
export const relayOrigin = ({ bindHost, port }: Pick<SettingsValue["remote"], "bindHost" | "port">) => {
  const host = bindHost === "0.0.0.0" || bindHost === "::" ? "127.0.0.1" : bindHost
  return `http://${host.includes(":") ? `[${host}]` : host}:${port}`
}

export type CloudflaredLine = { readonly type: "connected" } | { readonly type: "error"; readonly message: string }

/** What one stderr line of `cloudflared` says about the tunnel, or null when it says nothing we show. */
export const parseCloudflaredLine = (line: string): CloudflaredLine | null => {
  if (line.includes("Registered tunnel connection")) return { type: "connected" }
  const at = line.indexOf(" ERR ")
  return at === -1 ? null : { type: "error", message: line.slice(at + 5).trim() }
}

/** The tunnel the relay service made for this machine. `origin` is the listener address last sent to it. */
export const RelayTunnel = Schema.Struct({ hostname: Schema.String, origin: Schema.String })
export type RelayTunnel = typeof RelayTunnel.Type

export interface RelayOptions {
  /** The relay service, `https://relay.hinacode.app` by default. */
  readonly serviceUrl?: string
  readonly fetch?: Fetch
  /** The `cloudflared` executable, found on PATH by default. */
  readonly cloudflared?: string
}

/**
 * This machine's relay: linking it to a HinaCode account, unlinking it, and the `cloudflared` child that runs
 * while the remote listener is on. Every status change also goes to `RemoteAccess`, which answers `remote.status`.
 */
export class Relay extends Context.Service<
  Relay,
  {
    /**
     * Gives this machine a tunnel. Unlinked, it first starts a sign-in, hands it to `onLink` to open or print,
     * and returns once the owner approved it, failing when the link expires or `remove` cancels it.
     */
    readonly setup: (input: {
      readonly onLink: (link: RelayLink) => Effect.Effect<void>
    }) => Effect.Effect<void, RelayError | PersistenceError>
    readonly remove: Effect.Effect<void, RelayError | PersistenceError>
    readonly status: Effect.Effect<RelayStatus>
    readonly changes: Stream.Stream<RelayStatus>
  }
>()("hinacode/Relay") {}

const StoredTunnel = Schema.fromJsonString(RelayTunnel)

/** The stored tunnel, or null. `hinacode pair` reads it without starting the relay. */
export const storedTunnel = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const find = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: Schema.Struct({ value: StoredTunnel }),
    execute: (key) => sql`SELECT value FROM setting WHERE key = ${key}`,
  })
  return Option.getOrNull(Option.map(yield* find(TUNNEL_KEY), ({ value }) => value))
}).pipe(Effect.mapError(persistence("relay.load")))

type ChildEvent =
  | { readonly type: "line"; readonly line: string }
  | { readonly type: "failed"; readonly error: NodeJS.ErrnoException }
  | { readonly type: "closed"; readonly code: number | null; readonly signal: NodeJS.Signals | null }

type Outcome = { readonly type: "missing" } | { readonly type: "exited"; readonly error: string; readonly upMs: number }

const make = ({
  serviceUrl = DEFAULT_RELAY_SERVICE_URL,
  fetch = globalThis.fetch,
  cloudflared = "cloudflared",
}: RelayOptions) =>
  Effect.gen(function* () {
    const service = relayService(fetch, serviceUrl)
    const sql = yield* SqlClient.SqlClient
    const secrets = yield* Secrets
    const settings = yield* Settings
    const access = yield* RemoteAccess
    const lock = yield* Semaphore.make(1)
    const connector = yield* FiberHandle.make()
    const linking = yield* FiberHandle.make<void, RelayError | PersistenceError>()
    const status = yield* SubscriptionRef.make<RelayStatus>({ state: "off" })

    let tunnel = yield* storedTunnel
    let remote = (yield* settings.get).remote

    const publish = (next: RelayStatus) =>
      Effect.gen(function* () {
        if (Equal.equals(yield* SubscriptionRef.get(status), next)) return
        yield* access.report({ relay: next })
        yield* SubscriptionRef.set(status, next)
      })

    const save = (next: RelayTunnel) =>
      Schema.encodeEffect(StoredTunnel)(next).pipe(
        Effect.flatMap(
          (json) => sql`
            INSERT INTO setting (key, value) VALUES (${TUNNEL_KEY}, ${json})
            ON CONFLICT (key) DO UPDATE SET value = excluded.value
          `,
        ),
        Effect.mapError(persistence("relay.save")),
        Effect.andThen(Effect.sync(() => void (tunnel = next))),
      )

    const requireSecret = (name: string, missing: string) =>
      Effect.flatMap(secrets.get(name), (value) =>
        Option.isSome(value) ? Effect.succeed(value.value) : Effect.fail(new RelayError({ message: missing })),
      )

    const putTunnel = (credential: string) =>
      Effect.gen(function* () {
        const origin = relayOrigin(remote)
        const { hostname, connectorToken } = yield* service.putTunnel(credential, origin)
        yield* secrets.set(CONNECTOR_TOKEN_SECRET, connectorToken)
        yield* save({ hostname, origin })
      })

    /** Sends the listener's current address to the relay service when the tunnel points elsewhere. */
    const routed = (current: RelayTunnel) =>
      Effect.gen(function* () {
        if (current.origin === relayOrigin(remote)) return
        yield* putTunnel(
          yield* requireSecret(
            CREDENTIAL_SECRET,
            "This machine's relay sign-in is gone, so the tunnel cannot follow the listener. Turn on the relay again.",
          ),
        )
      })

    /** Runs `cloudflared` once, until it exits. Interruption kills it. */
    const runOnce = (hostname: string, token: string) =>
      Effect.gen(function* () {
        const events = yield* Queue.unbounded<ChildEvent>()
        yield* Effect.acquireRelease(
          Effect.sync(() => {
            const child = spawn(cloudflared, CLOUDFLARED_ARGS, {
              env: { ...process.env, TUNNEL_TOKEN: token },
              stdio: ["ignore", "ignore", "pipe"],
            })
            createInterface({ input: child.stderr }).on("line", (line) =>
              Queue.offerUnsafe(events, { type: "line", line }),
            )
            child.once("error", (error) => Queue.offerUnsafe(events, { type: "failed", error }))
            child.once("close", (code, signal) => Queue.offerUnsafe(events, { type: "closed", code, signal }))
            return child
          }),
          (child) => Effect.sync(() => child.kill("SIGTERM")),
        )
        const startedAt = yield* Clock.currentTimeMillis
        let lastError: string | null = null
        for (;;) {
          const event = yield* Queue.take(events)
          if (event.type === "failed") {
            if (event.error.code === "ENOENT") return { type: "missing" } satisfies Outcome
            return { type: "exited", error: `Cannot start cloudflared: ${event.error.message}`, upMs: 0 } as Outcome
          }
          if (event.type === "closed") {
            const upMs = (yield* Clock.currentTimeMillis) - startedAt
            const exit = event.code === null ? `stopped by ${event.signal}` : `exited with code ${event.code}`
            return { type: "exited", error: lastError ?? `cloudflared ${exit}`, upMs } as Outcome
          }
          const parsed = parseCloudflaredLine(event.line)
          if (parsed?.type === "connected") yield* publish({ state: "connected", hostname })
          if (parsed?.type === "error") lastError = parsed.message
        }
      }).pipe(Effect.scoped)

    /** Keeps `cloudflared` running for `stored`, restarting it with backoff, until interrupted. */
    const keepConnected = (stored: RelayTunnel) =>
      Effect.gen(function* () {
        const { hostname } = stored
        let error: string | null = null
        let retryMs = FIRST_RETRY_MS
        for (;;) {
          const outcome: Outcome = yield* Effect.gen(function* () {
            yield* routed(tunnel ?? stored)
            const token = yield* requireSecret(
              CONNECTOR_TOKEN_SECRET,
              "The tunnel's connector token is gone. Turn on the relay again.",
            )
            return yield* runOnce(hostname, token)
          }).pipe(
            Effect.catch((failure) => Effect.succeed<Outcome>({ type: "exited", error: failure.message, upMs: 0 })),
          )
          if (outcome.type === "missing") {
            error = null
            yield* publish({ state: "missing", hostname })
            yield* Effect.sleep(Duration.millis(LAST_RETRY_MS))
            continue
          }
          error = outcome.error
          yield* Effect.logWarning("cloudflared stopped", error)
          yield* publish({ state: "connecting", hostname, error })
          if (outcome.upMs >= HEALTHY_MS) retryMs = FIRST_RETRY_MS
          yield* Effect.sleep(Duration.millis(retryMs))
          retryMs = Math.min(retryMs * 2, LAST_RETRY_MS)
        }
      })

    const apply = Effect.gen(function* () {
      yield* FiberHandle.clear(connector)
      if (tunnel === null) return yield* publish({ state: "off" })
      if (!remote.enabled) return yield* publish({ state: "paused", hostname: tunnel.hostname })
      yield* publish({ state: "connecting", hostname: tunnel.hostname, error: null })
      yield* FiberHandle.run(connector, keepConnected(tunnel))
    })

    const linked = (credential: string) => putTunnel(credential).pipe(Effect.andThen(apply))

    /** Claims the credential every `interval` seconds until the owner approves, then links. */
    const claimUntilApproved = (link: typeof Link.Type) =>
      Effect.gen(function* () {
        for (;;) {
          yield* Effect.sleep(Duration.seconds(link.interval))
          if ((yield* Clock.currentTimeMillis) >= link.expiresAt) return yield* new RelayError({ message: EXPIRED })
          const credential = yield* service.claim(link.deviceCode)
          if (Option.isNone(credential)) continue
          yield* secrets.set(CREDENTIAL_SECRET, credential.value)
          return yield* lock.withPermit(linked(credential.value))
        }
      }).pipe(
        // Not under the lock: `remove` holds it while it interrupts this fiber.
        Effect.onExit((exit) =>
          Exit.isSuccess(exit) ? Effect.void : tunnel === null ? publish({ state: "off" }) : apply,
        ),
      )

    const setup = ({ onLink }: { readonly onLink: (link: RelayLink) => Effect.Effect<void> }) =>
      Effect.gen(function* () {
        yield* FiberHandle.clear(linking)
        const pending = yield* lock.withPermit(
          Effect.gen(function* () {
            const credential = yield* secrets.get(CREDENTIAL_SECRET)
            if (Option.isSome(credential)) return yield* Effect.as(linked(credential.value), null)
            const link = yield* service.createLink(access.identity.id, access.identity.name)
            yield* publish({ state: "linking", url: link.url, userCode: link.userCode })
            yield* onLink({ url: link.url, userCode: link.userCode })
            return yield* FiberHandle.run(linking, claimUntilApproved(link))
          }),
        )
        // The lock is free while the owner signs in, so removal and settings changes are never held up by it.
        if (pending !== null) yield* Fiber.join(pending)
      })

    const remove = lock.withPermit(
      Effect.gen(function* () {
        yield* FiberHandle.clear(linking)
        yield* FiberHandle.clear(connector)
        const credential = yield* secrets.get(CREDENTIAL_SECRET)
        if (Option.isSome(credential)) yield* service.deleteHost(credential.value).pipe(Effect.tapError(() => apply))
        yield* sql`DELETE FROM setting WHERE key = ${TUNNEL_KEY}`.pipe(Effect.mapError(persistence("relay.remove")))
        yield* secrets.clear(CREDENTIAL_SECRET)
        yield* secrets.clear(CONNECTOR_TOKEN_SECRET)
        tunnel = null
        yield* apply
      }),
    )

    yield* apply
    yield* (yield* settings.changes).pipe(
      Stream.runForEach((next) => {
        const { enabled, bindHost, port } = next.remote
        if (enabled === remote.enabled && bindHost === remote.bindHost && port === remote.port) return Effect.void
        remote = next.remote
        return lock.withPermit(apply)
      }),
      Effect.forkScoped,
    )

    return Relay.of({
      setup,
      remove,
      status: SubscriptionRef.get(status),
      changes: SubscriptionRef.changes(status),
    })
  })

export const layer = (options: RelayOptions = {}) => Layer.effect(Relay, make(options))
