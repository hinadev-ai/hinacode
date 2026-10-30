import { randomUUID } from "node:crypto"
import { Clock, Context, Deferred, Effect, Fiber, FiberMap, Layer, Option, Schedule, Schema } from "effect"
import { SqlClient, SqlSchema } from "effect/sql"
import { type RawData, WebSocket } from "ws"
import { methodKind, type RpcEnvelope, type RpcMethod } from "../../shared/contract.ts"
import { Environment, type EnvironmentStatus, type Environments as EnvironmentList } from "../../shared/domain.ts"
import { clientProof, newNonce, serverProof } from "../../shared/proof.ts"
import {
  CHALLENGE_WAIT_MS,
  type ClientFrame,
  type Dial,
  DIRECT_CHECK_INTERVAL_MS,
  DIRECT_CHECK_TIMEOUT_MS,
  dialPlan,
  type PairingTarget,
  parsePairingUrl,
  REMOTE_PROTOCOL_VERSION,
  relayWebSocketUrl,
  remoteWebSocketUrl,
  ServerFrame,
} from "../../shared/remote.ts"
import type { RelayMachine } from "../../shared/relayMachines.ts"
import { planRelaySync } from "../../shared/relaySync.ts"
import { learnFromAnswer, learnFromPush, makeOwners, nameMachines, stampProjects } from "../../shared/owners.ts"
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

export class Environments extends Context.Service<
  Environments,
  {
    readonly list: Effect.Effect<EnvironmentList, PersistenceError>
    readonly add: (input: {
      readonly name: string
      readonly pairingUrl: string
    }) => Effect.Effect<
      Environment,
      InvalidPairingUrl | EnvironmentUnreachable | EnvironmentUnauthorized | PersistenceError
    >
    readonly remove: (id: string) => Effect.Effect<void, PersistenceError>
    readonly syncRelay: (machines: ReadonlyArray<RelayMachine>) => Effect.Effect<number, PersistenceError>
    readonly reconnect: (id: string) => Effect.Effect<void>
    readonly reconnectAll: Effect.Effect<void>
    readonly forward: (environmentId: string, call: ForwardedCall) => Effect.Effect<RpcEnvelope<unknown>>
    readonly gather: (call: ForwardedCall) => Effect.Effect<ReadonlyArray<unknown>>
    readonly owner: (entity: Entity, id: string) => string | undefined
    readonly answerAsks: (answer: (call: ForwardedCall) => Effect.Effect<RpcEnvelope<unknown>>) => Effect.Effect<void>
  }
>()("hinacode/Environments") {}

const tokenSecret = (id: string) => `environment.${id}.token`

const GATHER_TIMEOUT = "3 seconds"
const READY_TIMEOUT_MS = 10_000
const PING_INTERVAL = "10 seconds"
const SILENCE_LIMIT_MS = 25_000
const OFFLINE_LIMIT_MS = 60_000
const STABLE_MS = 60_000
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
const notAnswering: RpcEnvelope<never> = {
  error: { tag: "NotReady", message: "The desktop is still starting." },
}

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

interface DialHandlers {
  readonly onFrame: (frame: ServerFrame) => void
  readonly onUndecodable?: () => void
  readonly onPong?: () => void
  readonly onError?: (error: Error) => void
  readonly onClose: (code: number) => void
}

const dial = (url: string, token: string, plainToken: boolean, handlers: DialHandlers) =>
  Effect.map(Effect.context<never>(), (services) => {
    const socket = new WebSocket(url)
    let expected: string | null | undefined
    let authenticated = false
    let refused = false
    let waiting: Fiber.Fiber<void> | undefined
    const authenticate = (frame: Extract<ClientFrame, { type: "auth" }>) => socket.send(JSON.stringify(frame))
    const refuse = () => {
      refused = true
      socket.terminate()
    }
    socket.on("open", () => {
      waiting = Effect.runForkWith(services)(
        Effect.sleep(CHALLENGE_WAIT_MS).pipe(
          Effect.andThen(
            Effect.sync(() => {
              if (expected !== undefined) return
              if (!plainToken) return refuse()
              expected = null
              authenticate({ type: "auth", token })
            }),
          ),
        ),
      )
    })
    socket.on("message", (raw, isBinary) => {
      const frame = parseFrame(raw, isBinary)
      if (frame === undefined) return handlers.onUndecodable?.()
      if (authenticated) return handlers.onFrame(frame)
      if (frame.type === "challenge") {
        if (expected !== undefined) return
        waiting?.interruptUnsafe()
        const nonce = newNonce()
        expected = serverProof(token, nonce, frame.nonce)
        return authenticate({ type: "auth", nonce, proof: clientProof(token, frame.nonce, nonce) })
      }
      if (frame.type !== "ready") return
      if (expected === undefined || (expected !== null && frame.proof !== expected)) return refuse()
      authenticated = true
      handlers.onFrame(frame)
    })
    socket.on("pong", () => handlers.onPong?.())
    socket.on("error", (error) => handlers.onError?.(error))
    socket.on("close", (code) => {
      waiting?.interruptUnsafe()
      handlers.onClose(refused ? CLOSE_UNAUTHORIZED : code)
    })
    return socket
  })

const opens = (url: string) =>
  Effect.callback<boolean>((resume) => {
    const socket = new WebSocket(url)
    socket.on("open", () => {
      resume(Effect.succeed(true))
      socket.close()
    })
    socket.on("error", () => {})
    socket.on("close", () => resume(Effect.succeed(false)))
    return Effect.sync(() => socket.terminate())
  })

const firstToOpen = (dials: ReadonlyArray<Dial>, timeoutMs: number) =>
  Effect.gen(function* () {
    const won = yield* Deferred.make<Dial | null>()
    let failed = 0
    yield* Effect.forEach(
      dials,
      (planned) =>
        Effect.forkScoped(
          Effect.sleep(planned.delayMs).pipe(
            Effect.andThen(opens(planned.url)),
            Effect.flatMap((opened) => {
              if (opened) return Deferred.succeed(won, planned)
              failed++
              return failed === dials.length ? Deferred.succeed(won, null) : Effect.void
            }),
          ),
        ),
      { discard: true },
    )
    return yield* Deferred.await(won).pipe(
      Effect.timeoutOrElse({ duration: timeoutMs, orElse: () => Effect.succeed(null) }),
    )
  }).pipe(Effect.scoped)

const directAnswers = (direct: ReadonlyArray<Dial>): Effect.Effect<void> =>
  Effect.sleep(DIRECT_CHECK_INTERVAL_MS).pipe(
    Effect.andThen(firstToOpen(direct, DIRECT_CHECK_TIMEOUT_MS)),
    Effect.flatMap((opened) => (opened === null ? directAnswers(direct) : Effect.void)),
  )

const probe = (target: DialTarget, token: string, plainToken: boolean) => {
  const where = "relay" in target ? target.relay : `${target.host}:${target.port}`
  const url = "relay" in target ? relayWebSocketUrl(target.relay) : remoteWebSocketUrl(target)
  return Effect.gen(function* () {
    const answered = yield* Deferred.make<Ready, EnvironmentUnreachable | EnvironmentUnauthorized>()
    let reason = "the connection closed"
    let errorCode: string | undefined
    const socket: WebSocket = yield* Effect.acquireRelease(
      dial(url, token, plainToken, {
        onFrame: (frame) => {
          if (frame.type !== "ready") return
          Deferred.doneUnsafe(answered, Effect.succeed(frame))
          socket.close()
        },
        onError: (error) => {
          // FIXME: Node fails a host with several addresses with an AggregateError whose message is empty
          reason = error.message || reason
          errorCode = "code" in error && typeof error.code === "string" ? error.code : undefined
        },
        onClose: (code) => {
          if (code === CLOSE_UNAUTHORIZED || code === CLOSE_TOKEN_ROTATED) {
            return Deferred.doneUnsafe(
              answered,
              Effect.fail(
                new EnvironmentUnauthorized({
                  message: `${where} refused the token. Copy a new pairing URL from hinacode serve.`,
                }),
              ),
            )
          }
          Deferred.doneUnsafe(
            answered,
            Effect.fail(new EnvironmentUnreachable({ message: unreachableMessage(target, errorCode, reason) })),
          )
        },
      }),
      (opened) => Effect.sync(() => opened.terminate()),
    )
    return yield* Deferred.await(answered)
  }).pipe(
    Effect.scoped,
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
            probe({ relay: pairing.relay }, pairing.token, true).pipe(
              Effect.tap((ready) => {
                relayReady = ready
                return startGrace
              }),
              Effect.result,
            ),
          )
    const probes = yield* Effect.forEach(pairing.hosts, (host, index) =>
      Effect.forkScoped(
        probe({ host, port: pairing.port }, pairing.token, pairing.relay === null).pipe(
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
  protocol: number | null
  live: Live | null
  wake: Deferred.Deferred<void> | null
  readonly outbox: Map<number, Pending>
  readonly remembered: Map<RpcMethod, { readonly payload: string; readonly result: unknown }>
}

interface SessionEnd {
  readonly code: number
  readonly ready: boolean
  readonly otherProtocol: number | null
  readonly connectedMs: number
}

const sendFrame = (socket: WebSocket, frame: ClientFrame) => {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame))
}

const send = (live: Live, call: Pending) => {
  const key = live.dedupesCalls ? call.key : undefined
  call.sent = true
  call.sentWithoutDedupe = call.key !== undefined && key === undefined
  const frame: ClientFrame = { type: "call", id: call.id, method: call.method, payload: call.payload }
  live.socket.send(JSON.stringify(key === undefined ? frame : { ...frame, key }))
}

const environmentDialPlan = ({ host, port, relay }: Environment) => dialPlan({ hosts: [host], port, relay })

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
  let answer: (call: ForwardedCall) => Effect.Effect<RpcEnvelope<unknown>> = () => Effect.succeed(notAnswering)
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

  const session = (cloud: Cloud, token: string, url: string, plainToken: boolean) =>
    Effect.gen(function* () {
      const { id, name } = cloud.environment
      const closed = yield* Deferred.make<number>()
      let connectedAt: number | null = null
      let otherProtocol: number | null = null
      let heardAt = now()
      const heard = () => {
        heardAt = now()
        cloud.lastSeenAt = new Date(heardAt).toISOString()
      }
      const socket: WebSocket = yield* Effect.acquireRelease(
        dial(url, token, plainToken, {
          onFrame: (frame) => {
            heard()
            switch (frame.type) {
              case "ready": {
                if (frame.version !== REMOTE_PROTOCOL_VERSION) {
                  otherProtocol = frame.version
                  return socket.close()
                }
                connectedAt = now()
                cloud.protocol = null
                learnRelay(cloud, frame.relay ?? null)
                const live: Live = { socket, dedupesCalls: frame.features?.includes("call-keys") ?? false }
                cloud.live = live
                if (frame.features?.includes("asks")) sendFrame(socket, { type: "hub" })
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
              case "ask":
                return runFork(
                  answer({ method: frame.method, payload: frame.payload }).pipe(
                    Effect.map((envelope) => sendFrame(socket, { type: "answer", id: frame.id, envelope })),
                  ),
                )
            }
          },
          onUndecodable: () => runFork(Effect.logWarning("dropped an undecodable frame", name)),
          onPong: heard,
          onClose: (code) => {
            disconnect(cloud, socket)
            Deferred.doneUnsafe(closed, Effect.succeed(code))
          },
        }),
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
        ready: connectedAt !== null,
        otherProtocol,
        connectedMs: connectedAt === null ? 0 : now() - connectedAt,
      } satisfies SessionEnd
    }).pipe(Effect.scoped)

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
      let round: "both" | "direct" | "relay" = "both"
      for (;;) {
        const plan = environmentDialPlan(cloud.environment)
        const dials = round === "both" ? plan : plan.filter((planned) => planned.route === round)
        const won = yield* firstToOpen(dials, READY_TIMEOUT_MS)
        if (won === null) {
          if (round === "direct") {
            round = "both"
            continue
          }
          yield* setStatus(cloud, "offline")
        } else {
          const direct = plan.filter((planned) => planned.route === "direct")
          const hasRelay = plan.some((planned) => planned.route === "relay")
          const opened = session(cloud, token, won.url, won.route === "relay" || !hasRelay)
          const end =
            won.route === "relay" && round === "both" && direct.length > 0
              ? yield* Effect.raceFirst(opened, directAnswers(direct).pipe(Effect.as(null)))
              : yield* opened
          if (end === null) {
            round = "direct"
            continue
          }
          if (end.code === CLOSE_UNAUTHORIZED || end.code === CLOSE_TOKEN_ROTATED) {
            if (!end.ready && won.route === "direct" && hasRelay) {
              round = "relay"
              continue
            }
            failAll(cloud, unauthorized(name))
            return yield* setStatus(cloud, "unauthorized")
          }
          if (end.otherProtocol === null) {
            yield* setStatus(cloud, "offline")
          } else {
            cloud.protocol = end.otherProtocol
            failAll(cloud, incompatible(name))
            yield* setStatus(cloud, "incompatible")
          }
          if (end.connectedMs >= STABLE_MS) attempt = 0
        }
        round = "both"
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
      const rowById = new Map(rows.map((row) => [row.id, row]))
      let changed = drop.length > 0
      for (const { environmentId: id, name, pairing } of upsert) {
        const { port, token, relay } = pairing
        const host = pairing.hosts[0]
        const existing = rowById.get(id)
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
          const result = nameMachines(
            method,
            stampProjects(method, envelope.result, environmentId),
            cloud.environment.name,
          )
          cloud.remembered.set(method, { payload: JSON.stringify(payload ?? null), result })
          return { result }
        }),
      )
    })

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
    answerAsks: (answerWith) =>
      Effect.sync(() => {
        answer = answerWith
      }),
  })
})

export const layer = Layer.effect(Environments, make)
