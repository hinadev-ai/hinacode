import { randomUUID } from "node:crypto"
import { Clock, Context, Deferred, Effect, Fiber, FiberMap, Layer, Option, Schedule, Schema } from "effect"
import { SqlClient, SqlSchema } from "effect/sql"
import { type RawData, WebSocket } from "ws"
import { methodKind, type RpcEnvelope, type RpcMethod } from "../../shared/contract.ts"
import { Environment, type EnvironmentStatus, type Environments as EnvironmentList } from "../../shared/domain.ts"
import {
  type ClientFrame,
  type PairingTarget,
  parsePairingUrl,
  REMOTE_PROTOCOL_VERSION,
  relayWebSocketUrl,
  remoteSocketUrls,
  remoteWebSocketUrl,
  ServerFrame,
} from "../../shared/remote.ts"
import { planRelaySync, type RelayMachine } from "../../shared/relayMachines.ts"
import { learnFromAnswer, learnFromPush, makeOwners, stampProjects } from "../../shared/owners.ts"
import type { Entity } from "../../shared/routes.ts"
import { type DialTarget, unreachableMessage } from "../environments/unreachable.ts"
import { CLOSE_TOKEN_ROTATED, CLOSE_UNAUTHORIZED, RemoteAccess } from "../remote/access.ts"
import { type PersistenceError, persistence } from "./errors.ts"
import { Events, WindowPush } from "./Events.ts"
import { Secrets } from "./Secrets.ts"

export class InvalidPairingUrl extends Schema.TaggedError<InvalidPairingUrl>()("InvalidPairingUrl", {
  message: Schema.String,
}) {}
export class EnvironmentUnreachable extends Schema.TaggedError<EnvironmentUnreachable>()("EnvironmentUnreachable", {
  message: Schema.String,
}) {}
export class EnvironmentUnauthorized extends Schema.TaggedError<EnvironmentUnauthorized>()("EnvironmentUnauthorized", {
  message: Schema.String,
}) {}

export interface ForwardedCall {
  readonly method: RpcMethod
  readonly payload: unknown
}

/** The clouds this desktop paired with, one live connection each. */
export class Environments extends Context.Service<
  Environments,
  {
    readonly list: Effect.Effect<EnvironmentList, PersistenceError>
    /** Connects once with the pairing URL's token before saving it. A cloud already listed is updated in place. */
    readonly add: (input: {
      readonly name: string
      readonly pairingUrl: string
    }) => Effect.Effect<
      Environment,
      InvalidPairingUrl | EnvironmentUnreachable | EnvironmentUnauthorized | PersistenceError
    >
    readonly remove: (id: string) => Effect.Effect<void, PersistenceError>
    /**
     * Makes the clouds match the relay's list without dialing them, since the relay already named each one. Answers
     * how many listed machines this desktop now has. A cloud paired by URL is refreshed but never dropped or renamed.
     */
    readonly syncRelay: (machines: ReadonlyArray<RelayMachine>) => Effect.Effect<number, PersistenceError>
    /** Dials a cloud now instead of after its backoff. Does nothing while it is connected or refused its token. */
    readonly reconnect: (id: string) => Effect.Effect<void>
    /** `reconnect` for every cloud, for when the network may have come back, such as waking from sleep. */
    readonly reconnectAll: Effect.Effect<void>
    /**
     * Runs one call on a cloud. A call made or cut off while the cloud is unreachable waits for it to reconnect, and
     * answers `Timeout` once the cloud has been unreachable for a minute in total.
     */
    readonly forward: (environmentId: string, call: ForwardedCall) => Effect.Effect<RpcEnvelope<unknown>>
    /**
     * Runs a call that answers an array on every cloud and concatenates the answers. A cloud that cannot answer
     * contributes its last answer to the same call, or nothing.
     */
    readonly gather: (call: ForwardedCall) => Effect.Effect<ReadonlyArray<unknown>>
    /** The cloud that owns `id`, or undefined when it is this desktop's. */
    readonly owner: (entity: Entity, id: string) => string | undefined
  }
>()("hinacode/Environments") {}

const tokenSecret = (id: string) => `environment.${id}.token`

const GATHER_TIMEOUT = "3 seconds"
const READY_TIMEOUT_MS = 10_000
const PING_INTERVAL = "10 seconds"
const SILENCE_LIMIT_MS = 25_000
const OFFLINE_LIMIT_MS = 60_000
const STABLE_MS = 60_000
/** How long pairing waits for an earlier host in the URL once a later one answered. */
const PREFER_EARLIER_HOST_MS = 1_000

const reconnectDelay = (attempt: number) => Math.min(500 * 2 ** attempt, 60_000) * (0.7 + Math.random() * 0.6)

const offline = (name: string): RpcEnvelope<never> => ({
  error: { tag: "EnvironmentOffline", message: `${name} is offline` },
})
const unauthorized = (name: string): RpcEnvelope<never> => ({
  error: { tag: "EnvironmentUnauthorized", message: `${name} refused this desktop's token. Pair it again.` },
})
const incompatible = (name: string): RpcEnvelope<never> => ({
  error: { tag: "EnvironmentIncompatible", message: `${name} runs a hinacode this desktop cannot talk to` },
})
const unknownEnvironment = (id: string): RpcEnvelope<never> => ({
  error: { tag: "NotFoundError", message: `No environment with id ${id}` },
})

const decodeServerFrame = Schema.decodeUnknownOption(ServerFrame)

const parseFrame = (raw: RawData, isBinary: boolean): ServerFrame | undefined => {
  if (isBinary) return undefined
  try {
    return Option.getOrUndefined(decodeServerFrame(JSON.parse(String(raw))))
  } catch {
    return undefined
  }
}

type Ready = Extract<ServerFrame, { type: "ready" }>

interface Dial {
  readonly onFrame: (frame: ServerFrame) => void
  readonly onUndecodable?: () => void
  readonly onPong?: () => void
  readonly onError?: (error: Error) => void
  readonly onClose: (code: number) => void
}

/** Opens a socket to a cloud's remote listener and authenticates as soon as it opens. */
const dial = (url: string, token: string, handlers: Dial) => {
  const socket = new WebSocket(url)
  socket.on("open", () => socket.send(JSON.stringify({ type: "auth", token } satisfies ClientFrame)))
  socket.on("message", (raw, isBinary) => {
    const frame = parseFrame(raw, isBinary)
    if (frame === undefined) handlers.onUndecodable?.()
    else handlers.onFrame(frame)
  })
  socket.on("pong", () => handlers.onPong?.())
  socket.on("error", (error) => handlers.onError?.(error))
  socket.on("close", handlers.onClose)
  return socket
}

/** Succeeds with the cloud's `ready` frame once it accepts `token`. */
const probe = (target: DialTarget, token: string) => {
  const where = "relay" in target ? target.relay : `${target.host}:${target.port}`
  const url = "relay" in target ? relayWebSocketUrl(target.relay) : remoteWebSocketUrl(target)
  return Effect.callback<Ready, EnvironmentUnreachable | EnvironmentUnauthorized>((resume) => {
    let reason = "the connection closed"
    let errorCode: string | undefined
    const socket = dial(url, token, {
      onFrame: (frame) => {
        if (frame.type !== "ready") return
        resume(Effect.succeed(frame))
        socket.close()
      },
      onError: (error) => {
        // A host with several addresses fails with an AggregateError, whose message is empty.
        reason = error.message || reason
        errorCode = "code" in error && typeof error.code === "string" ? error.code : undefined
      },
      onClose: (code) => {
        if (code === CLOSE_UNAUTHORIZED || code === CLOSE_TOKEN_ROTATED) {
          return resume(
            Effect.fail(
              new EnvironmentUnauthorized({
                message: `${where} refused the token. Copy a new pairing URL from hinacode serve.`,
              }),
            ),
          )
        }
        resume(Effect.fail(new EnvironmentUnreachable({ message: unreachableMessage(target, errorCode, reason) })))
      },
    })
    return Effect.sync(() => socket.terminate())
  }).pipe(
    Effect.timeoutOrElse({
      duration: READY_TIMEOUT_MS,
      orElse: () =>
        Effect.fail(
          new EnvironmentUnreachable({
            message: unreachableMessage(target, "ETIMEDOUT", `no answer within ${READY_TIMEOUT_MS / 1000} seconds`),
          }),
        ),
    }),
  )
}

/**
 * Probes every host of a pairing and its relay at once and keeps the first host in URL order that answers, or the
 * first host when only the relay answered. Once anything answered, earlier hosts get `PREFER_EARLIER_HOST_MS` more,
 * so an address this desktop cannot reach, such as a Tailscale address off the tailnet, does not hold pairing for
 * the whole probe timeout. When nothing answers, a refused token outranks unreachable hosts.
 */
const probeHosts = (pairing: PairingTarget) =>
  Effect.gen(function* () {
    const answers: Array<Ready | undefined> = []
    const graceOver = yield* Deferred.make<void>()
    let graceStarted = false
    const startGrace = Effect.suspend(() => {
      if (graceStarted) return Effect.void
      graceStarted = true
      return Effect.forkScoped(
        Effect.sleep(PREFER_EARLIER_HOST_MS).pipe(Effect.andThen(Deferred.succeed(graceOver, undefined))),
      )
    })
    let relayReady: Ready | undefined
    const relayProbe =
      pairing.relay === null
        ? null
        : yield* Effect.forkScoped(
            probe({ relay: pairing.relay }, pairing.token).pipe(
              Effect.tap((ready) => {
                relayReady = ready
                return startGrace
              }),
              Effect.result,
            ),
          )
    const probes = yield* Effect.forEach(pairing.hosts, (host, index) =>
      Effect.forkScoped(
        probe({ host, port: pairing.port }, pairing.token).pipe(
          Effect.tap((ready) => {
            answers[index] = ready
            return startGrace
          }),
          Effect.result,
        ),
      ),
    )
    const failures: Array<EnvironmentUnreachable | EnvironmentUnauthorized> = []
    for (const fiber of probes) {
      const outcome = yield* Effect.raceFirst(Fiber.join(fiber), Deferred.await(graceOver).pipe(Effect.as(null)))
      if (outcome === null || outcome._tag === "Success") break
      failures.push(outcome.failure)
    }
    const won = answers.findIndex((ready) => ready !== undefined)
    if (won !== -1) return { host: pairing.hosts[won]!, ready: answers[won]! }
    if (relayProbe !== null && relayReady === undefined) {
      const outcome = yield* Fiber.join(relayProbe)
      if (outcome._tag === "Failure") failures.push(outcome.failure)
    }
    if (relayReady !== undefined) return { host: pairing.hosts[0], ready: relayReady }
    return yield* Effect.fail(failures.find((error) => error._tag === "EnvironmentUnauthorized") ?? failures[0]!)
  }).pipe(Effect.scoped)

interface Live {
  readonly socket: WebSocket
  readonly dedupesCalls: boolean
}

interface Pending {
  readonly id: number
  readonly method: RpcMethod
  readonly payload: unknown
  readonly key: string | undefined
  readonly answer: (envelope: RpcEnvelope<unknown>) => void
  sent: boolean
  sentWithoutDedupe: boolean
  priorOfflineMs: number
  offlineSince: number | null
  timer: Fiber.Fiber<void> | null
}

interface Cloud {
  environment: Environment
  status: EnvironmentStatus
  lastSeenAt: string | null
  /** The cloud's protocol version while it speaks another one than this desktop. */
  protocol: number | null
  /** Set only while the socket is authenticated, so a call never goes to a socket that is still dialing. */
  live: Live | null
  /** Set only while waiting out the backoff; completing it dials at once. */
  wake: Deferred.Deferred<void> | null
  readonly outbox: Map<number, Pending>
  /** The last successful answer per method, for `gather` while the cloud cannot answer. */
  readonly remembered: Map<RpcMethod, { readonly payload: string; readonly result: unknown }>
}

interface SessionEnd {
  readonly code: number
  /** Whether the cloud sent `ready`, so the URL reached it. */
  readonly answered: boolean
  /** The cloud's protocol version when it is not this desktop's. */
  readonly otherProtocol: number | null
  readonly connectedMs: number
}

const send = (live: Live, call: Pending) => {
  const key = live.dedupesCalls ? call.key : undefined
  call.sent = true
  call.sentWithoutDedupe = call.key !== undefined && key === undefined
  const frame: ClientFrame = { type: "call", id: call.id, method: call.method, payload: call.payload }
  live.socket.send(JSON.stringify(key === undefined ? frame : { ...frame, key }))
}

const socketUrls = ({ host, port, relay }: Environment) => remoteSocketUrls({ hosts: [host], port, relay })

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const secrets = yield* Secrets
  const events = yield* Events
  const windows = yield* WindowPush
  const self = (yield* RemoteAccess).identity
  const clock = yield* Clock.Clock
  const runFork = Effect.runForkWith(yield* Effect.context<never>())
  const owners = makeOwners()
  const clouds = new Map<string, Cloud>()
  let nextCallId = 1
  const now = () => clock.currentTimeMillisUnsafe()

  const findAll = SqlSchema.findAll({
    Request: Schema.Void,
    Result: Environment,
    execute: () => sql`SELECT id, name, host, port, relay, source, created_at FROM environment ORDER BY created_at`,
  })
  const findOne = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: Environment,
    execute: (id) => sql`SELECT id, name, host, port, relay, source, created_at FROM environment WHERE id = ${id}`,
  })

  const setStatus = (cloud: Cloud, status: EnvironmentStatus) =>
    Effect.suspend(() => {
      if (cloud.status === status) return Effect.void
      cloud.status = status
      return events.publish({ type: "environment.status", id: cloud.environment.id, status })
    })

  const pauseOfflineTimer = (call: Pending) => {
    if (call.offlineSince === null) return
    call.priorOfflineMs += now() - call.offlineSince
    call.offlineSince = null
    call.timer?.interruptUnsafe()
    call.timer = null
  }

  const settle = (cloud: Cloud, call: Pending, envelope: RpcEnvelope<unknown>) => {
    pauseOfflineTimer(call)
    cloud.outbox.delete(call.id)
    call.answer(envelope)
  }

  const expire = (cloud: Cloud, call: Pending) => {
    const { name } = cloud.environment
    const message =
      call.sent && call.key !== undefined
        ? `${name} was unreachable for a minute. The call may still have run there.`
        : `Not sent. ${name} was unreachable for a minute.`
    settle(cloud, call, { error: { tag: "Timeout", message } })
  }

  const startOfflineTimer = (cloud: Cloud, call: Pending) => {
    call.offlineSince = now()
    call.timer = runFork(
      Effect.sleep(OFFLINE_LIMIT_MS - call.priorOfflineMs).pipe(
        Effect.andThen(
          Effect.sync(() => {
            call.timer = null
            expire(cloud, call)
          }),
        ),
      ),
    )
  }

  const failAll = (cloud: Cloud, envelope: RpcEnvelope<unknown>) => {
    for (const call of cloud.outbox.values()) settle(cloud, call, envelope)
  }

  const disconnect = (cloud: Cloud, socket: WebSocket) => {
    if (cloud.live?.socket !== socket) return
    cloud.live = null
    const { name } = cloud.environment
    for (const call of cloud.outbox.values()) {
      if (call.sentWithoutDedupe) {
        settle(cloud, call, {
          error: { tag: "EnvironmentOffline", message: `${name} went offline. The call may still have run there.` },
        })
      } else if (call.offlineSince === null) startOfflineTimer(cloud, call)
    }
  }

  /** Keeps the relay the cloud reports, so the next dial reaches it from any network. */
  const learnRelay = (cloud: Cloud, relay: string | null) => {
    if (cloud.environment.relay === relay) return
    cloud.environment = { ...cloud.environment, relay }
    const { id } = cloud.environment
    runFork(
      sql`UPDATE environment SET relay = ${relay} WHERE id = ${id}`.pipe(
        Effect.catchCause((cause) => Effect.logWarning("could not save the relay", cause)),
      ),
    )
  }

  /** Resolves once the socket closes. Interrupting it drops the socket. */
  const session = (cloud: Cloud, token: string, url: string) =>
    Effect.gen(function* () {
      const { id, name } = cloud.environment
      const closed = yield* Deferred.make<number>()
      let answered = false
      let connectedAt: number | null = null
      let otherProtocol: number | null = null
      let heardAt = now()
      const heard = () => {
        heardAt = now()
        cloud.lastSeenAt = new Date(heardAt).toISOString()
      }
      const socket = yield* Effect.acquireRelease(
        Effect.sync(() =>
          dial(url, token, {
            onFrame: (frame) => {
              heard()
              switch (frame.type) {
                case "ready": {
                  answered = true
                  if (frame.version !== REMOTE_PROTOCOL_VERSION) {
                    otherProtocol = frame.version
                    return socket.close()
                  }
                  connectedAt = now()
                  cloud.protocol = null
                  learnRelay(cloud, frame.relay ?? null)
                  const live: Live = { socket, dedupesCalls: frame.features?.includes("call-keys") ?? false }
                  cloud.live = live
                  for (const call of cloud.outbox.values()) {
                    pauseOfflineTimer(call)
                    if (call.priorOfflineMs >= OFFLINE_LIMIT_MS) expire(cloud, call)
                    else send(live, call)
                  }
                  return runFork(setStatus(cloud, "connected"))
                }
                case "result": {
                  const call = cloud.outbox.get(frame.id)
                  if (call === undefined) return
                  return settle(
                    cloud,
                    call,
                    "error" in frame.envelope ? frame.envelope : { result: frame.envelope.result },
                  )
                }
                case "event":
                  learnFromPush(owners, id, frame.event)
                  return runFork(windows.send(frame.event))
                case "pong":
                  return
              }
            },
            onUndecodable: () => runFork(Effect.logWarning("dropped an undecodable frame", name)),
            onPong: heard,
            onClose: (code) => {
              disconnect(cloud, socket)
              Deferred.doneUnsafe(closed, Effect.succeed(code))
            },
          }),
        ),
        (opened) =>
          Effect.sync(() => {
            disconnect(cloud, opened)
            opened.terminate()
          }),
      )
      yield* Effect.forkScoped(
        Effect.sleep(READY_TIMEOUT_MS).pipe(
          Effect.andThen(
            Effect.sync(() => {
              if (connectedAt === null) socket.terminate()
            }),
          ),
        ),
      )
      yield* Effect.forkScoped(
        Effect.sync(() => {
          if (connectedAt !== null && socket.readyState === WebSocket.OPEN) socket.ping()
        }).pipe(Effect.repeat(Schedule.spaced(PING_INTERVAL))),
      )
      const dropWhenSilent: Effect.Effect<void> = Effect.suspend(() => {
        const left = heardAt + SILENCE_LIMIT_MS - now()
        if (left <= 0) return Effect.sync(() => socket.terminate())
        return Effect.sleep(left).pipe(Effect.andThen(dropWhenSilent))
      })
      yield* Effect.forkScoped(dropWhenSilent)
      const code = yield* Deferred.await(closed)
      return {
        code,
        answered,
        otherProtocol,
        connectedMs: connectedAt === null ? 0 : now() - connectedAt,
      } satisfies SessionEnd
    }).pipe(Effect.scoped)

  /**
   * Keeps `cloud` connected until interrupted or refused. A cloud on another protocol version keeps being retried,
   * so it reconnects on its own once updated. A dial that gets no `ready` moves on to the next of `socketUrls` at
   * once, and only a whole round without one waits out the backoff. A dial that got `ready` starts the next round
   * from the same URL.
   */
  const maintain = (cloud: Cloud) =>
    Effect.gen(function* () {
      const { name } = cloud.environment
      const token = Option.getOrNull(yield* secrets.get(tokenSecret(cloud.environment.id)))
      if (token === null) {
        failAll(cloud, unauthorized(name))
        return yield* setStatus(cloud, "unauthorized")
      }
      yield* setStatus(cloud, "connecting")
      let attempt = 0
      let index = 0
      let unanswered = 0
      for (;;) {
        const url = socketUrls(cloud.environment)[index]!
        const end = yield* session(cloud, token, url)
        if (end.code === CLOSE_UNAUTHORIZED || end.code === CLOSE_TOKEN_ROTATED) {
          failAll(cloud, unauthorized(name))
          return yield* setStatus(cloud, "unauthorized")
        }
        const urls = socketUrls(cloud.environment)
        if (end.answered) {
          index = Math.max(0, urls.indexOf(url))
          unanswered = 0
        } else {
          index = (index + 1) % urls.length
          unanswered++
          if (unanswered < urls.length) continue
          unanswered = 0
        }
        if (end.otherProtocol === null) {
          yield* setStatus(cloud, "offline")
        } else {
          cloud.protocol = end.otherProtocol
          failAll(cloud, incompatible(name))
          yield* setStatus(cloud, "incompatible")
        }
        if (end.connectedMs >= STABLE_MS) attempt = 0
        const wake = yield* Deferred.make<void>()
        cloud.wake = wake
        const woken = yield* Effect.race(
          Effect.sleep(reconnectDelay(attempt)).pipe(Effect.as(false)),
          Deferred.await(wake).pipe(Effect.as(true)),
        )
        cloud.wake = null
        attempt = woken ? 0 : attempt + 1
      }
    }).pipe(Effect.catchCause((cause) => Effect.logWarning("environment connection stopped", cause)))

  const connections = yield* FiberMap.make<string>()
  yield* Effect.addFinalizer(() =>
    FiberMap.clear(connections).pipe(
      Effect.andThen(
        Effect.sync(() => {
          for (const cloud of clouds.values()) failAll(cloud, offline(cloud.environment.name))
        }),
      ),
    ),
  )

  const start = (environment: Environment) =>
    Effect.suspend(() => {
      const existing = clouds.get(environment.id)
      const cloud: Cloud = existing ?? {
        environment,
        status: "connecting",
        lastSeenAt: null,
        protocol: null,
        live: null,
        wake: null,
        outbox: new Map(),
        remembered: new Map(),
      }
      cloud.environment = environment
      clouds.set(environment.id, cloud)
      return FiberMap.run(connections, environment.id, maintain(cloud))
    })

  const list = Effect.gen(function* () {
    const rows = yield* findAll(undefined).pipe(Effect.mapError(persistence("environments.list")))
    return {
      clouds: rows.map((row) => {
        const cloud = clouds.get(row.id)
        const entry = { ...row, status: cloud?.status ?? "offline", lastSeenAt: cloud?.lastSeenAt ?? null }
        return cloud?.status === "incompatible" && cloud.protocol !== null
          ? { ...entry, protocol: cloud.protocol }
          : entry
      }),
    }
  })

  const add = (input: { readonly name: string; readonly pairingUrl: string }) =>
    Effect.gen(function* () {
      const pairing = parsePairingUrl(input.pairingUrl)
      if (pairing === null) {
        return yield* new InvalidPairingUrl({
          message: "Paste the hinacode://connect URL that hinacode serve printed.",
        })
      }
      const { host, ready } = yield* probeHosts(pairing)
      const { port, token, relay } = pairing
      if (ready.environment?.id === self.id) {
        return yield* new InvalidPairingUrl({ message: "That pairing URL is for this desktop." })
      }
      const typed = input.name.trim()
      const id = ready.environment?.id ?? randomUUID()
      const existing = Option.getOrNull(yield* findOne(id).pipe(Effect.mapError(persistence("environments.add"))))
      const environment: Environment = existing
        ? { ...existing, name: typed || existing.name, host, port, relay }
        : {
            id,
            name: typed || ready.environment?.name || host,
            host,
            port,
            relay,
            source: "pairing",
            createdAt: new Date().toISOString(),
          }
      const write = existing
        ? sql`UPDATE environment SET name = ${environment.name}, host = ${host}, port = ${port}, relay = ${relay} WHERE id = ${id}`
        : sql`INSERT INTO environment ${sql.insert(environment)}`
      yield* write.pipe(
        Effect.andThen(secrets.set(tokenSecret(id), token)),
        sql.withTransaction,
        Effect.catchTag("SqlError", (error) => Effect.fail(persistence("environments.add")(error))),
      )
      yield* start(environment)
      return environment
    })

  const remove = (id: string) =>
    Effect.gen(function* () {
      yield* FiberMap.remove(connections, id)
      const cloud = clouds.get(id)
      if (cloud !== undefined) failAll(cloud, unknownEnvironment(id))
      yield* sql`DELETE FROM environment WHERE id = ${id}`.pipe(Effect.mapError(persistence("environments.remove")))
      yield* secrets.clear(tokenSecret(id))
      clouds.delete(id)
      owners.forget(id)
    })

  const syncRelay = (machines: ReadonlyArray<RelayMachine>) =>
    Effect.gen(function* () {
      const failed = persistence("environments.syncRelay")
      const rows = yield* findAll(undefined).pipe(Effect.mapError(failed))
      const { upsert, drop } = planRelaySync(
        rows.map((row) => ({ ...row, environmentId: row.id })),
        machines,
        self.id,
      )
      let changed = drop.length > 0
      for (const { environmentId: id, name, pairing } of upsert) {
        const { port, token, relay } = pairing
        const host = pairing.hosts[0]
        const existing = rows.find((row) => row.id === id)
        if (existing === undefined) {
          const environment: Environment = {
            id,
            name,
            host,
            port,
            relay,
            source: "relay",
            createdAt: new Date().toISOString(),
          }
          yield* sql`INSERT INTO environment ${sql.insert(environment)}`.pipe(
            Effect.andThen(secrets.set(tokenSecret(id), token)),
            sql.withTransaction,
            Effect.catchTag("SqlError", (error) => Effect.fail(failed(error))),
          )
          yield* start(environment)
          changed = true
          continue
        }
        const environment: Environment = {
          ...existing,
          name: existing.source === "relay" ? name : existing.name,
          host,
          port,
          relay,
        }
        const redial =
          host !== existing.host ||
          port !== existing.port ||
          relay !== existing.relay ||
          token !== Option.getOrNull(yield* secrets.get(tokenSecret(id)))
        if (!redial && environment.name === existing.name) continue
        yield* sql`UPDATE environment SET name = ${environment.name}, host = ${host}, port = ${port}, relay = ${relay} WHERE id = ${id}`.pipe(
          Effect.andThen(secrets.set(tokenSecret(id), token)),
          sql.withTransaction,
          Effect.catchTag("SqlError", (error) => Effect.fail(failed(error))),
        )
        changed = true
        const cloud = clouds.get(id)
        if (redial || cloud === undefined) yield* start(environment)
        else cloud.environment = environment
      }
      yield* Effect.forEach(drop, (row) => remove(row.id), { discard: true })
      if (changed) yield* events.publish({ type: "environments.changed" })
      return upsert.length
    })

  const reconnect = (id: string) =>
    Effect.suspend(() => {
      const cloud = clouds.get(id)
      const wake = cloud?.wake
      if (cloud === undefined || wake == null) return Effect.void
      cloud.wake = null
      return setStatus(cloud, "connecting").pipe(Effect.andThen(Deferred.succeed(wake, undefined)))
    })

  const reconnectAll = Effect.suspend(() => Effect.forEach([...clouds.keys()], reconnect, { discard: true }))

  const forward = (environmentId: string, { method, payload }: ForwardedCall) =>
    Effect.suspend(() => {
      const cloud = clouds.get(environmentId)
      if (cloud === undefined) return Effect.succeed(unknownEnvironment(environmentId))
      const { name } = cloud.environment
      if (cloud.status === "unauthorized") return Effect.succeed(unauthorized(name))
      if (cloud.status === "incompatible") return Effect.succeed(incompatible(name))
      return Effect.callback<RpcEnvelope<unknown>>((resume) => {
        const call: Pending = {
          id: nextCallId++,
          method,
          payload,
          key: methodKind[method] === "mutation" ? randomUUID() : undefined,
          answer: (envelope) => resume(Effect.succeed(envelope)),
          sent: false,
          sentWithoutDedupe: false,
          priorOfflineMs: 0,
          offlineSince: null,
          timer: null,
        }
        cloud.outbox.set(call.id, call)
        if (cloud.live === null) startOfflineTimer(cloud, call)
        else send(cloud.live, call)
        return Effect.sync(() => {
          pauseOfflineTimer(call)
          cloud.outbox.delete(call.id)
        })
      }).pipe(
        Effect.map((envelope) => {
          if ("error" in envelope) return envelope
          learnFromAnswer(owners, environmentId, method, payload, envelope.result)
          const result = stampProjects(method, envelope.result, environmentId)
          cloud.remembered.set(method, { payload: JSON.stringify(payload ?? null), result })
          return { result }
        }),
      )
    })

  /** A cloud that answers slowly, or not at all over a half-open socket, must not hold up this desktop's list. */
  const gather = (call: ForwardedCall) =>
    Effect.forEach(
      [...clouds.values()],
      (cloud) =>
        Effect.map(
          cloud.live === null
            ? Effect.succeedNone
            : Effect.timeoutOption(forward(cloud.environment.id, call), GATHER_TIMEOUT),
          (answer) => {
            const envelope = Option.getOrUndefined(answer)
            if (envelope !== undefined && "result" in envelope && Array.isArray(envelope.result)) return envelope.result
            const last = cloud.remembered.get(call.method)
            return last?.payload === JSON.stringify(call.payload ?? null) && Array.isArray(last.result)
              ? last.result
              : []
          },
        ),
      { concurrency: "unbounded" },
    ).pipe(Effect.map((answers) => answers.flat()))

  yield* Effect.forEach(yield* findAll(undefined).pipe(Effect.mapError(persistence("environments.load"))), start)

  return Environments.of({
    list,
    add,
    remove,
    syncRelay,
    reconnect,
    reconnectAll,
    forward,
    gather,
    owner: owners.owner,
  })
})

export const layer = Layer.effect(Environments, make)
