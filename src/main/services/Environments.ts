import { randomUUID } from "node:crypto"
import { hostname } from "node:os"
import { Clock, Context, Deferred, Effect, Fiber, FiberMap, Layer, Option, Schedule, Schema } from "effect"
import { SqlClient, SqlSchema } from "effect/sql"
import { type RawData, WebSocket } from "ws"
import { clientSession, type Hello } from "../../shared/clientSession.ts"
import { methodKind, type PushEvent, type RpcEnvelope, type RpcMethod, RpcMethods } from "../../shared/contract.ts"
import {
  Environment,
  type EnvironmentStatus,
  type Environments as EnvironmentList,
  type HostApproval,
  type HostRefusal,
} from "../../shared/domain.ts"
import { decodeKey, generateKeyPair, type KeyPair, keyPairFromSecret } from "../../shared/noise.ts"
import {
  type ClientFrame,
  CLOSE_HANDSHAKE_FAILED,
  CLOSE_PAIRING_RESET,
  CLOSE_UNAUTHORIZED,
  type Dial,
  DIRECT_CHECK_INTERVAL_MS,
  DIRECT_CHECK_TIMEOUT_MS,
  dialPlan,
  type PairingTarget,
  parsePairingUrl,
  REMOTE_PROTOCOL_VERSION,
  relayWebSocketUrl,
  remoteWebSocketUrl,
  type ServerFrame,
} from "../../shared/remote.ts"
import type { RelayMachine } from "../../shared/relayMachines.ts"
import { planRelaySync } from "../../shared/relaySync.ts"
import {
  learnFromAnswer,
  learnFromPush,
  makeOwners,
  nameMachines,
  stampEnvironment,
  stampPush,
} from "../../shared/owners.ts"
import type { Entity } from "../../shared/routes.ts"
import { type DialTarget, unreachableMessage } from "../environments/unreachable.ts"
import { OFFLINE_LIMIT_MS } from "../../shared/transport.ts"
import { RemoteAccess } from "../remote/access.ts"
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

export interface CloudHooks {
  readonly pushed: (environmentId: string, event: PushEvent) => Effect.Effect<void>
  readonly answered: (environmentId: string, method: RpcMethod) => Effect.Effect<void>
  readonly offlineMutation: (environmentId: string) => Effect.Effect<void>
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
    readonly rename: (id: string, name: string) => Effect.Effect<void, PersistenceError>
    readonly syncRelay: (machines: ReadonlyArray<RelayMachine>) => Effect.Effect<number, PersistenceError>
    readonly repair: (id: string) => Effect.Effect<void, PersistenceError>
    readonly confirmHost: (id: string, accepted: boolean) => Effect.Effect<void, PersistenceError>
    readonly reconnect: (id: string) => Effect.Effect<void>
    readonly reconnectAll: Effect.Effect<void>
    readonly forward: (environmentId: string, call: ForwardedCall) => Effect.Effect<RpcEnvelope<unknown>>
    readonly gather: (call: ForwardedCall) => Effect.Effect<ReadonlyArray<unknown>>
    readonly owner: (entity: Entity, id: string) => string | undefined
    readonly answerAsks: (answer: (call: ForwardedCall) => Effect.Effect<RpcEnvelope<unknown>>) => Effect.Effect<void>
    readonly hook: (hooks: CloudHooks) => Effect.Effect<void>
  }
>()("hinacode/Environments") {}

const pairingSecret = (id: string) => `environment.${id}.token`
const DEVICE_KEY_SECRET = "remote.deviceKey"
const DEVICE_NAME_MAX = 64

const GATHER_TIMEOUT = "3 seconds"
const READY_TIMEOUT_MS = 10_000
const PING_INTERVAL = "10 seconds"
const SILENCE_LIMIT_MS = 25_000
const STABLE_MS = 60_000
const PREFER_EARLIER_HOST_MS = 1_000

const reconnectDelay = (attempt: number) => Math.min(500 * 2 ** attempt, 60_000) * (0.7 + Math.random() * 0.6)

const deviceName = () => hostname().slice(0, DEVICE_NAME_MAX) || "HinaCode"

const offline = (name: string): RpcEnvelope<never> => ({
  error: { tag: "EnvironmentOffline", message: `${name} is offline` },
})
const refusalMessage = (name: string, refusal: HostRefusal) => {
  switch (refusal) {
    case "refused":
      return `${name} did not accept this device. If you reset its pairing, pair again from its QR code.`
    case "removed":
      return `${name} no longer accepts this device. Pair it again.`
    case "reset":
      return `${name} reset its pairing. Pair it again.`
    case "predates":
      return `Pair ${name} again: this pairing predates encryption.`
  }
}
const unauthorized = (name: string, refusal: HostRefusal): RpcEnvelope<never> => ({
  error: { tag: "EnvironmentUnauthorized", message: refusalMessage(name, refusal) },
})
const incompatible = (name: string): RpcEnvelope<never> => ({
  error: { tag: "EnvironmentIncompatible", message: `${name} runs a hinacode this desktop cannot talk to` },
})
const versionMismatch = (name: string): RpcEnvelope<never> => ({
  error: { tag: "EnvironmentVersionMismatch", message: name },
})
const fitsThisVersion = (method: RpcMethod, result: unknown) =>
  Option.isSome(Schema.decodeUnknownOption(RpcMethods[method].response as Schema.Codec<unknown, unknown>)(result))
const unknownEnvironment = (id: string): RpcEnvelope<never> => ({
  error: { tag: "NotFoundError", message: `No environment with id ${id}` },
})
const notAnswering: RpcEnvelope<never> = {
  error: { tag: "NotReady", message: "The desktop is still starting." },
}

type Ready = Extract<ServerFrame, { type: "ready" }>

interface Credentials {
  readonly hostKey: Uint8Array
  readonly device: KeyPair
  readonly hello: Hello
}

interface LinkEnd {
  readonly code: number
  readonly handshaken: boolean
  readonly refused: boolean
}

interface DialHandlers {
  readonly onPending?: () => void
  readonly onCode?: (code: string) => void
  readonly onFrame: (frame: ServerFrame) => void
  readonly onBroken?: () => void
  readonly onPong?: () => void
  readonly onError?: (error: Error) => void
  readonly onClose: (end: LinkEnd) => void
}

interface Link {
  readonly socket: WebSocket
  readonly send: (frame: ClientFrame) => void
}

const binary = (raw: RawData) => (Array.isArray(raw) ? Buffer.concat(raw) : raw)

const dial = (url: string, credentials: Credentials, handlers: DialHandlers): Link => {
  const socket = new WebSocket(url)
  let refused = false
  const session = clientSession({
    ...credentials,
    send: (data) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(data)
    },
  })
  socket.on("open", () => session.start())
  socket.on("message", (raw, isBinary) => {
    const received = session.receive(isBinary ? binary(raw) : String(raw))
    switch (received.type) {
      case "pending":
        return handlers.onPending?.()
      case "code":
        return handlers.onCode?.(received.code)
      case "frame":
        return handlers.onFrame(received.frame)
      case "refused":
        refused = true
        return socket.terminate()
      case "broken":
        handlers.onBroken?.()
        return socket.terminate()
    }
  })
  socket.on("pong", () => handlers.onPong?.())
  socket.on("error", (error) => handlers.onError?.(error))
  socket.on("close", (code) =>
    handlers.onClose({ code, handshaken: session.handshaken(), refused: refused || code === CLOSE_HANDSHAKE_FAILED }),
  )
  return {
    socket,
    send: (frame) => {
      if (socket.readyState === WebSocket.OPEN && session.handshaken()) session.send(frame)
    },
  }
}

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

const directAnswers = (direct: ReadonlyArray<Dial>, waitingForApproval: () => boolean): Effect.Effect<void> =>
  Effect.sleep(DIRECT_CHECK_INTERVAL_MS).pipe(
    Effect.andThen(
      Effect.suspend(() =>
        waitingForApproval() ? Effect.succeed(null) : firstToOpen(direct, DIRECT_CHECK_TIMEOUT_MS),
      ),
    ),
    Effect.flatMap((opened) => (opened === null ? directAnswers(direct, waitingForApproval) : Effect.void)),
  )

type Probed = { readonly ready: Ready } | { readonly pending: true }

const probe = (target: DialTarget, credentials: Credentials) => {
  const where = "relay" in target ? target.relay : `${target.host}:${target.port}`
  const url = "relay" in target ? relayWebSocketUrl(target.relay) : remoteWebSocketUrl(target)
  return Effect.gen(function* () {
    const answered = yield* Deferred.make<Probed, EnvironmentUnreachable | EnvironmentUnauthorized>()
    let reason = "the connection closed"
    let errorCode: string | undefined
    const link: Link = yield* Effect.acquireRelease(
      Effect.sync(() =>
        dial(url, credentials, {
          onPending: () => {
            Deferred.doneUnsafe(answered, Effect.succeed({ pending: true }))
            link.socket.close()
          },
          onFrame: (frame) => {
            if (frame.type !== "ready") return
            Deferred.doneUnsafe(answered, Effect.succeed({ ready: frame }))
            link.socket.close()
          },
          onError: (error) => {
            // FIXME: Node fails a host with several addresses with an AggregateError whose message is empty
            reason = error.message || reason
            errorCode = "code" in error && typeof error.code === "string" ? error.code : undefined
          },
          onClose: (end) => {
            const refusal = refusalOf(end, false)
            if (refusal !== null) {
              return Deferred.doneUnsafe(
                answered,
                Effect.fail(new EnvironmentUnauthorized({ message: refusalMessage(where, refusal) })),
              )
            }
            Deferred.doneUnsafe(
              answered,
              Effect.fail(new EnvironmentUnreachable({ message: unreachableMessage(target, errorCode, reason) })),
            )
          },
        }),
      ),
      (opened) => Effect.sync(() => opened.socket.terminate()),
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

const refusalOf = (end: LinkEnd, ready: boolean): HostRefusal | null => {
  if (end.refused) return "refused"
  if (end.code === CLOSE_PAIRING_RESET) return "reset"
  if (end.code === CLOSE_UNAUTHORIZED) return ready ? "removed" : "refused"
  return null
}

const probeHosts = (pairing: PairingTarget, credentials: Credentials) =>
  Effect.gen(function* () {
    const answers: Array<Probed | undefined> = []
    const graceOver = yield* Deferred.make<void>()
    let graceStarted = false
    const startGrace = Effect.suspend(() => {
      if (graceStarted) return Effect.void
      graceStarted = true
      return Effect.forkScoped(
        Effect.sleep(PREFER_EARLIER_HOST_MS).pipe(Effect.andThen(Deferred.succeed(graceOver, undefined))),
      )
    })
    let relayAnswer: Probed | undefined
    const relayProbe =
      pairing.relay === null
        ? null
        : yield* Effect.forkScoped(
            probe({ relay: pairing.relay }, credentials).pipe(
              Effect.tap((answer) => {
                relayAnswer = answer
                return startGrace
              }),
              Effect.result,
            ),
          )
    const probes = yield* Effect.forEach(pairing.hosts, (host, index) =>
      Effect.forkScoped(
        probe({ host, port: pairing.port }, credentials).pipe(
          Effect.tap((answer) => {
            answers[index] = answer
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
    const all = [...answers, relayAnswer]
    const usedSecret = all.some((answer) => answer !== undefined && "ready" in answer)
    const won = answers.findIndex((answer) => answer !== undefined)
    if (won !== -1) return { host: pairing.hosts[won]!, answer: answers[won]!, usedSecret }
    if (relayProbe !== null && relayAnswer === undefined) {
      const outcome = yield* Fiber.join(relayProbe)
      if (outcome._tag === "Failure") failures.push(outcome.failure)
    }
    if (relayAnswer !== undefined) {
      return { host: pairing.hosts[0], answer: relayAnswer, usedSecret: usedSecret || "ready" in relayAnswer }
    }
    return yield* Effect.fail(failures.find((error) => error._tag === "EnvironmentUnauthorized") ?? failures[0]!)
  }).pipe(Effect.scoped)

interface Live {
  readonly link: Link
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
  hostKey: string | null
  verified: boolean
  status: EnvironmentStatus
  approval: HostApproval | null
  refusal: HostRefusal | null
  lastSeenAt: string | null
  protocol: number | null
  live: Live | null
  wake: Deferred.Deferred<void> | null
  answerHost: ((accepted: boolean) => Effect.Effect<void, PersistenceError>) | null
  readonly outbox: Map<number, Pending>
  readonly remembered: Map<RpcMethod, { readonly payload: string; readonly result: unknown }>
}

interface SessionEnd {
  readonly link: LinkEnd
  readonly ready: boolean
  readonly stalled: boolean
  readonly declined: boolean
  readonly otherProtocol: number | null
  readonly connectedMs: number
}

const StoredEnvironment = Schema.Struct({
  ...Environment.fields,
  hostKey: Schema.NullOr(Schema.String),
  verified: Schema.BooleanFromBit,
})
type StoredEnvironment = typeof StoredEnvironment.Type

const environmentOf = ({ hostKey: _hostKey, verified: _verified, ...environment }: StoredEnvironment): Environment =>
  environment

const send = (live: Live, call: Pending) => {
  const key = live.dedupesCalls ? call.key : undefined
  call.sent = true
  call.sentWithoutDedupe = call.key !== undefined && key === undefined
  const frame: ClientFrame = { type: "call", id: call.id, method: call.method, payload: call.payload }
  live.link.send(key === undefined ? frame : { ...frame, key })
}

const environmentDialPlan = ({ host, port, relay }: Environment) => dialPlan({ hosts: [host], port, relay })

const loadDeviceKey = Effect.gen(function* () {
  const secrets = yield* Secrets
  const stored = Option.getOrNull(yield* secrets.get(DEVICE_KEY_SECRET))
  if (stored !== null) return keyPairFromSecret(Buffer.from(stored, "base64url"))
  const device = generateKeyPair()
  yield* secrets.set(DEVICE_KEY_SECRET, Buffer.from(device.secretKey).toString("base64url"))
  return device
})

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const secrets = yield* Secrets
  const events = yield* Events
  const windows = yield* WindowPush
  const self = (yield* RemoteAccess).identity
  const clock = yield* Clock.Clock
  const device = yield* loadDeviceKey
  const runFork = Effect.runForkWith(yield* Effect.context<never>())
  const owners = makeOwners()
  const clouds = new Map<string, Cloud>()
  const relayMachines = new Map<string, RelayMachine>()
  let nextCallId = 1
  let answer: (call: ForwardedCall) => Effect.Effect<RpcEnvelope<unknown>> = () => Effect.succeed(notAnswering)
  let hooks: CloudHooks = { pushed: () => Effect.void, answered: () => Effect.void, offlineMutation: () => Effect.void }
  const now = () => clock.currentTimeMillisUnsafe()
  const nowIso = () => new Date(now()).toISOString()

  const findAll = SqlSchema.findAll({
    Request: Schema.Void,
    Result: StoredEnvironment,
    execute: () =>
      sql`SELECT id, name, host, port, relay, source, created_at, host_key, verified FROM environment ORDER BY created_at`,
  })
  const findOne = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: StoredEnvironment,
    execute: (id) =>
      sql`SELECT id, name, host, port, relay, source, created_at, host_key, verified FROM environment WHERE id = ${id}`,
  })

  const setStatus = (
    cloud: Cloud,
    status: EnvironmentStatus,
    detail: { readonly approval?: HostApproval; readonly refusal?: HostRefusal } = {},
  ) =>
    Effect.suspend(() => {
      const approval = detail.approval ?? null
      const refusal = detail.refusal ?? null
      const same =
        cloud.status === status &&
        cloud.refusal === refusal &&
        cloud.approval?.code === approval?.code &&
        cloud.approval?.accepted === approval?.accepted
      cloud.status = status
      cloud.approval = approval
      cloud.refusal = refusal
      if (same) return Effect.void
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
    if (cloud.live?.link.socket !== socket) return
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

  const markVerified = (cloud: Cloud) =>
    sql`UPDATE environment SET verified = 1 WHERE id = ${cloud.environment.id}`.pipe(
      Effect.mapError(persistence("environments.confirmHost")),
      Effect.andThen(
        Effect.sync(() => {
          cloud.verified = true
        }),
      ),
    )

  const session = (cloud: Cloud, credentials: Credentials, url: string, viaRelay: boolean) =>
    Effect.gen(function* () {
      const { id, name } = cloud.environment
      const closed = yield* Deferred.make<LinkEnd>()
      let connectedAt: number | null = null
      let otherProtocol: number | null = null
      let awaitingApproval = false
      let code: string | null = null
      let declined = false
      let stalled = false
      let heardAt = now()
      const heard = () => {
        heardAt = now()
        cloud.lastSeenAt = new Date(heardAt).toISOString()
      }
      const goLive = (frame: Ready) => {
        if (link.socket.readyState !== WebSocket.OPEN) return
        connectedAt = now()
        cloud.protocol = null
        learnRelay(cloud, frame.relay ?? (viaRelay ? cloud.environment.relay : null))
        const live: Live = { link, dedupesCalls: frame.features?.includes("call-keys") ?? false }
        cloud.live = live
        if (frame.features?.includes("asks")) link.send({ type: "hub" })
        for (const call of cloud.outbox.values()) {
          pauseOfflineTimer(call)
          if (call.priorOfflineMs >= OFFLINE_LIMIT_MS) expire(cloud, call)
          else send(live, call)
        }
        runFork(setStatus(cloud, "connected"))
      }
      const ready = (frame: Ready) => {
        if (frame.version !== REMOTE_PROTOCOL_VERSION) {
          otherProtocol = frame.version
          return link.socket.close()
        }
        if (credentials.hello.secret !== undefined) {
          runFork(
            secrets
              .clear(pairingSecret(id))
              .pipe(Effect.catchCause((cause) => Effect.logWarning("could not drop a used pairing secret", cause))),
          )
        }
        if (cloud.verified) return goLive(frame)
        if (code === null) {
          declined = true
          return link.socket.close()
        }
        cloud.answerHost = (accepted) =>
          Effect.suspend(() => {
            cloud.answerHost = null
            if (!accepted) {
              declined = true
              return Effect.sync(() => link.socket.close())
            }
            return markVerified(cloud).pipe(Effect.andThen(Effect.sync(() => goLive(frame))))
          })
        runFork(setStatus(cloud, "approval", { approval: { code, accepted: true } }))
      }
      const link: Link = yield* Effect.acquireRelease(
        Effect.sync(() =>
          dial(url, credentials, {
            onPending: () => {
              heard()
              awaitingApproval = true
            },
            onCode: (shown) => {
              heard()
              code = shown
              runFork(setStatus(cloud, "approval", { approval: { code: shown, accepted: false } }))
            },
            onFrame: (frame) => {
              heard()
              if (frame.type !== "ready" && cloud.live?.link !== link) return
              switch (frame.type) {
                case "ready":
                  return ready(frame)
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
                  runFork(hooks.pushed(id, frame.event))
                  return runFork(windows.send(stampPush(frame.event, id)))
                case "ask":
                  return runFork(
                    answer({ method: frame.method, payload: frame.payload }).pipe(
                      Effect.map((envelope) => link.send({ type: "answer", id: frame.id, envelope })),
                    ),
                  )
                default:
                  return
              }
            },
            onBroken: () => runFork(Effect.logWarning("closed a link whose frame did not decrypt", name)),
            onPong: heard,
            onClose: (end) => {
              cloud.answerHost = null
              disconnect(cloud, link.socket)
              Deferred.doneUnsafe(closed, Effect.succeed(end))
            },
          }),
        ),
        (opened) =>
          Effect.sync(() => {
            cloud.answerHost = null
            disconnect(cloud, opened.socket)
            opened.socket.terminate()
          }),
      )
      yield* Effect.forkScoped(
        Effect.sleep(READY_TIMEOUT_MS).pipe(
          Effect.andThen(
            Effect.sync(() => {
              if (connectedAt !== null || awaitingApproval) return
              stalled = true
              link.socket.terminate()
            }),
          ),
        ),
      )
      yield* Effect.forkScoped(
        Effect.sync(() => {
          if (link.socket.readyState === WebSocket.OPEN) link.socket.ping()
        }).pipe(Effect.repeat(Schedule.spaced(PING_INTERVAL))),
      )
      const dropWhenSilent: Effect.Effect<void> = Effect.suspend(() => {
        const left = heardAt + SILENCE_LIMIT_MS - now()
        if (left <= 0) return Effect.sync(() => link.socket.terminate())
        return Effect.sleep(left).pipe(Effect.andThen(dropWhenSilent))
      })
      yield* Effect.forkScoped(dropWhenSilent)
      const end = yield* Deferred.await(closed)
      return {
        link: end,
        ready: connectedAt !== null,
        stalled,
        declined,
        otherProtocol,
        connectedMs: connectedAt === null ? 0 : now() - connectedAt,
      } satisfies SessionEnd
    }).pipe(Effect.scoped)

  const refuse = (cloud: Cloud, refusal: HostRefusal) => {
    failAll(cloud, unauthorized(cloud.environment.name, refusal))
    return setStatus(cloud, "unauthorized", { refusal })
  }

  const maintain = (cloud: Cloud) =>
    Effect.gen(function* () {
      const { id } = cloud.environment
      const hostKey = cloud.hostKey === null ? null : decodeKey(cloud.hostKey)
      if (hostKey === null) return yield* refuse(cloud, "predates")
      yield* setStatus(cloud, "connecting")
      let attempt = 0
      let round: "both" | "direct" | "relay" = "both"
      for (;;) {
        const secret = Option.getOrNull(yield* secrets.get(pairingSecret(id)))
        const credentials: Credentials = {
          hostKey,
          device,
          hello: {
            name: deviceName(),
            ...(secret !== null && { secret }),
            ...(!cloud.verified && { verify: true }),
          },
        }
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
          const opened = session(cloud, credentials, won.url, won.route === "relay")
          const end =
            won.route === "relay" && round === "both" && direct.length > 0
              ? yield* Effect.raceFirst(
                  opened,
                  directAnswers(direct, () => cloud.status === "approval").pipe(Effect.as(null)),
                )
              : yield* opened
          if (end === null) {
            round = "direct"
            continue
          }
          if ((!end.link.handshaken || end.stalled) && won.route === "direct" && hasRelay) {
            round = "relay"
            continue
          }
          const refusal = end.declined ? "refused" : refusalOf(end.link, end.ready)
          if (refusal !== null) return yield* refuse(cloud, refusal)
          if (end.otherProtocol === null) {
            yield* setStatus(cloud, "offline")
          } else {
            cloud.protocol = end.otherProtocol
            failAll(cloud, incompatible(cloud.environment.name))
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

  const start = (stored: StoredEnvironment) =>
    Effect.suspend(() => {
      const environment = environmentOf(stored)
      const existing = clouds.get(environment.id)
      const cloud: Cloud = existing ?? {
        environment,
        hostKey: stored.hostKey,
        verified: stored.verified,
        status: "connecting",
        approval: null,
        refusal: null,
        lastSeenAt: null,
        protocol: null,
        live: null,
        wake: null,
        answerHost: null,
        outbox: new Map(),
        remembered: new Map(),
      }
      cloud.environment = environment
      cloud.hostKey = stored.hostKey
      cloud.verified = stored.verified
      clouds.set(environment.id, cloud)
      return FiberMap.run(connections, environment.id, maintain(cloud))
    })

  const list = Effect.gen(function* () {
    const rows = yield* findAll(undefined).pipe(Effect.mapError(persistence("environments.list")))
    return {
      clouds: rows.map((row) => {
        const cloud = clouds.get(row.id)
        return {
          ...environmentOf(row),
          status: cloud?.status ?? "offline",
          lastSeenAt: cloud?.lastSeenAt ?? null,
          ...(cloud?.status === "incompatible" && cloud.protocol !== null && { protocol: cloud.protocol }),
          ...(cloud?.approval != null && { approval: cloud.approval }),
          ...(cloud?.refusal != null && { refusal: cloud.refusal }),
        }
      }),
    }
  })

  const add = (input: { readonly name: string; readonly pairingUrl: string }) =>
    Effect.gen(function* () {
      const pairing = parsePairingUrl(input.pairingUrl)
      const hostKey = pairing === null ? null : decodeKey(pairing.key)
      if (pairing === null || hostKey === null) {
        return yield* new InvalidPairingUrl({
          message: "Paste the hinacode://connect URL that hinacode serve printed.",
        })
      }
      const { port, key, relay, secret } = pairing
      const credentials: Credentials = {
        hostKey,
        device,
        hello: { name: deviceName(), ...(secret !== null && { secret }) },
      }
      const { host, answer: probed, usedSecret } = yield* probeHosts(pairing, credentials)
      const ready = "ready" in probed ? probed.ready : null
      if (ready?.environment?.id === self.id) {
        return yield* new InvalidPairingUrl({ message: "That pairing URL is for this desktop." })
      }
      const typed = input.name.trim()
      const id = ready?.environment?.id ?? randomUUID()
      const existing = Option.getOrNull(yield* findOne(id).pipe(Effect.mapError(persistence("environments.add"))))
      const stored: StoredEnvironment = existing
        ? { ...existing, name: typed || existing.name, host, port, relay, hostKey: key, verified: true }
        : {
            id,
            name: typed || ready?.environment?.name || host,
            host,
            port,
            relay,
            source: "pairing",
            createdAt: nowIso(),
            hostKey: key,
            verified: true,
          }
      const write = existing
        ? sql`UPDATE environment SET name = ${stored.name}, host = ${host}, port = ${port}, relay = ${relay}, host_key = ${key}, verified = 1 WHERE id = ${id}`
        : sql`INSERT INTO environment ${sql.insert({ ...environmentOf(stored), hostKey: key, verified: 1 })}`
      const keepSecret = secret !== null && !usedSecret
      yield* write.pipe(
        Effect.andThen(keepSecret ? secrets.set(pairingSecret(id), secret) : secrets.clear(pairingSecret(id))),
        sql.withTransaction,
        Effect.catchTag("SqlError", (error) => Effect.fail(persistence("environments.add")(error))),
      )
      yield* start(stored)
      return environmentOf(stored)
    })

  const remove = (id: string) =>
    Effect.gen(function* () {
      yield* FiberMap.remove(connections, id)
      const cloud = clouds.get(id)
      if (cloud !== undefined) failAll(cloud, unknownEnvironment(id))
      yield* sql`DELETE FROM environment WHERE id = ${id}`.pipe(Effect.mapError(persistence("environments.remove")))
      yield* secrets.clear(pairingSecret(id))
      clouds.delete(id)
      owners.forget(id)
    })

  const rename = (id: string, name: string) =>
    Effect.gen(function* () {
      yield* sql`UPDATE environment SET name = ${name} WHERE id = ${id}`.pipe(
        Effect.mapError(persistence("environments.rename")),
      )
      const cloud = clouds.get(id)
      if (cloud !== undefined) cloud.environment = { ...cloud.environment, name }
      yield* events.publish({ type: "environments.changed" })
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
      relayMachines.clear()
      for (const machine of upsert) relayMachines.set(machine.environmentId, machine)
      const rowById = new Map(rows.map((row) => [row.id, row]))
      let changed = drop.length > 0
      for (const { environmentId: id, name, pairing } of upsert) {
        const { port, key, relay } = pairing
        const host = pairing.hosts[0]
        const existing = rowById.get(id)
        if (existing === undefined) {
          const stored: StoredEnvironment = {
            id,
            name,
            host,
            port,
            relay,
            source: "relay",
            createdAt: nowIso(),
            hostKey: key,
            verified: false,
          }
          yield* sql`INSERT INTO environment ${sql.insert({ ...environmentOf(stored), hostKey: key, verified: 0 })}`.pipe(
            Effect.mapError(failed),
          )
          yield* start(stored)
          changed = true
          continue
        }
        if (host === existing.host && port === existing.port && relay === existing.relay) continue
        yield* sql`UPDATE environment SET host = ${host}, port = ${port}, relay = ${relay} WHERE id = ${id}`.pipe(
          Effect.mapError(failed),
        )
        changed = true
        yield* start({ ...existing, host, port, relay })
      }
      yield* Effect.forEach(drop, (row) => remove(row.id), { discard: true })
      if (changed) yield* events.publish({ type: "environments.changed" })
      return upsert.length
    })

  const repair = (id: string) =>
    Effect.gen(function* () {
      const listed = relayMachines.get(id)
      const existing = Option.getOrNull(yield* findOne(id).pipe(Effect.mapError(persistence("environments.repair"))))
      if (listed === undefined || existing === null) return
      const { key } = listed.pairing
      yield* sql`UPDATE environment SET host_key = ${key}, verified = 0 WHERE id = ${id}`.pipe(
        Effect.mapError(persistence("environments.repair")),
      )
      yield* secrets.clear(pairingSecret(id))
      yield* start({ ...existing, hostKey: key, verified: false })
    })

  const confirmHost = (id: string, accepted: boolean) =>
    Effect.suspend(() => clouds.get(id)?.answerHost?.(accepted) ?? Effect.void)

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
      if (cloud.status === "unauthorized") return Effect.succeed(unauthorized(name, cloud.refusal ?? "refused"))
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
        if (cloud.live !== null) send(cloud.live, call)
        else {
          startOfflineTimer(cloud, call)
          if (call.key !== undefined) runFork(hooks.offlineMutation(environmentId))
        }
        return Effect.sync(() => {
          pauseOfflineTimer(call)
          cloud.outbox.delete(call.id)
        })
      }).pipe(
        Effect.map((envelope) => {
          if ("error" in envelope) return envelope
          runFork(hooks.answered(environmentId, method))
          const result = nameMachines(
            method,
            stampEnvironment(method, envelope.result, environmentId),
            cloud.environment.name,
          )
          if (!fitsThisVersion(method, result)) return versionMismatch(name)
          learnFromAnswer(owners, environmentId, method, payload, envelope.result)
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
    rename,
    syncRelay,
    repair,
    confirmHost,
    reconnect,
    reconnectAll,
    forward,
    gather,
    owner: owners.owner,
    answerAsks: (answerWith) =>
      Effect.sync(() => {
        answer = answerWith
      }),
    hook: (next) =>
      Effect.sync(() => {
        hooks = next
      }),
  })
})

export const layer = Layer.effect(Environments, make)
