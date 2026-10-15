import { randomUUID } from "node:crypto"
import { Context, Effect, FiberMap, Layer, Option, Schema } from "effect"
import { SqlClient, SqlSchema } from "effect/sql"
import { type RawData, WebSocket } from "ws"
import type { RpcEnvelope, RpcMethod } from "../../shared/contract.ts"
import { Environment, type EnvironmentStatus, type Environments as EnvironmentList } from "../../shared/domain.ts"
import {
  type ClientFrame,
  type PairingTarget,
  parsePairingUrl,
  REMOTE_PROTOCOL_VERSION,
  remoteWebSocketUrl,
  ServerFrame,
} from "../../shared/remote.ts"
import { learnFromAnswer, learnFromPush, makeOwners } from "../environments/owners.ts"
import type { Entity } from "../environments/routes.ts"
import { CLOSE_UNAUTHORIZED, RemoteAccess } from "../remote/access.ts"
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
    /** Runs one call on a cloud. Answers `EnvironmentOffline` when it is not connected. */
    readonly forward: (environmentId: string, call: ForwardedCall) => Effect.Effect<RpcEnvelope<unknown>>
    /**
     * Runs a call that answers an array on every cloud and concatenates the answers. A cloud that cannot answer
     * contributes its last answer to the same call, or nothing.
     */
    readonly gather: (call: ForwardedCall) => Effect.Effect<ReadonlyArray<unknown>>
    /** The cloud that owns `id`, or undefined when it is this desktop's. */
    readonly owner: (entity: Entity, id: string) => string | undefined
  }
>()("kkcode/Environments") {}

const tokenSecret = (id: string) => `environment.${id}.token`

const GATHER_TIMEOUT = "3 seconds"
const PROBE_TIMEOUT_MS = 5000
const PING_INTERVAL_MS = 10_000
const PONG_TIMEOUT_MS = 25_000
const RECONNECT_DELAYS_MS = [1000, 2000, 5000, 10_000, 30_000, 60_000]
const STABLE_MS = 60_000

const jittered = (ms: number) => ms * (0.8 + Math.random() * 0.4)

const offline = (name: string): RpcEnvelope<never> => ({
  error: { tag: "EnvironmentOffline", message: `${name} is offline` },
})
const unknownEnvironment = (id: string): RpcEnvelope<never> => ({
  error: { tag: "NotFoundError", message: `No environment with id ${id}` },
})

/** Answers that carry projects, which this desktop stamps with the cloud they came from. */
const projectAnswers: ReadonlySet<RpcMethod> = new Set<RpcMethod>([
  "projects.list",
  "projects.create",
  "projects.clone",
  "projects.update",
])

const stamp = (result: unknown, environmentId: string): unknown =>
  Array.isArray(result)
    ? result.map((project) => stamp(project, environmentId))
    : typeof result === "object" && result !== null
      ? { ...result, environmentId }
      : result

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
const dial = (target: Pick<PairingTarget, "host" | "port">, token: string, handlers: Dial) => {
  const socket = new WebSocket(remoteWebSocketUrl(target))
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
const probe = (target: PairingTarget) =>
  Effect.callback<Ready, EnvironmentUnreachable | EnvironmentUnauthorized>((resume) => {
    const where = `${target.host}:${target.port}`
    let reason = "the connection closed"
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      socket.terminate()
    }, PROBE_TIMEOUT_MS)
    const socket = dial(target, target.token, {
      onFrame: (frame) => {
        if (frame.type !== "ready") return
        clearTimeout(timer)
        resume(Effect.succeed(frame))
        socket.close()
      },
      onError: (error) => {
        reason = error.message
      },
      onClose: (code) => {
        clearTimeout(timer)
        if (code === CLOSE_UNAUTHORIZED) {
          return resume(
            Effect.fail(
              new EnvironmentUnauthorized({
                message: `${where} refused the token. Copy a new pairing URL from kkcode serve.`,
              }),
            ),
          )
        }
        const why = timedOut ? `no answer within ${PROBE_TIMEOUT_MS / 1000} seconds` : reason
        resume(Effect.fail(new EnvironmentUnreachable({ message: `Could not reach ${where}: ${why}` })))
      },
    })
    return Effect.sync(() => {
      clearTimeout(timer)
      socket.terminate()
    })
  })

interface Live {
  readonly socket: WebSocket
  readonly pending: Map<number, (envelope: RpcEnvelope<unknown>) => void>
}

interface Cloud {
  environment: Environment
  status: EnvironmentStatus
  lastSeenAt: string | null
  /** Set only while the socket is authenticated, so a call never goes to a socket that is still dialing. */
  live: Live | null
  /** The last successful answer per method, for `gather` while the cloud cannot answer. */
  readonly remembered: Map<RpcMethod, { readonly payload: string; readonly result: unknown }>
}

interface SessionEnd {
  readonly code: number
  readonly incompatible: boolean
  readonly connectedMs: number
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const secrets = yield* Secrets
  const events = yield* Events
  const windows = yield* WindowPush
  const self = (yield* RemoteAccess).identity
  const runFork = Effect.runForkWith(yield* Effect.context<never>())
  const owners = makeOwners()
  const clouds = new Map<string, Cloud>()
  let nextCallId = 1

  const findAll = SqlSchema.findAll({
    Request: Schema.Void,
    Result: Environment,
    execute: () => sql`SELECT id, name, host, port, created_at FROM environment ORDER BY created_at`,
  })
  const findOne = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: Environment,
    execute: (id) => sql`SELECT id, name, host, port, created_at FROM environment WHERE id = ${id}`,
  })

  const setStatus = (cloud: Cloud, status: EnvironmentStatus) =>
    Effect.suspend(() => {
      if (cloud.status === status) return Effect.void
      cloud.status = status
      return events.publish({ type: "environment.status", id: cloud.environment.id, status })
    })

  /** Resolves once the socket closes. Interrupting it drops the socket. */
  const session = (cloud: Cloud, token: string) =>
    Effect.callback<SessionEnd>((resume) => {
      const { id, name } = cloud.environment
      const pending: Live["pending"] = new Map()
      let connectedAt: number | null = null
      let incompatible = false
      let heardAt = Date.now()
      const heard = () => {
        heardAt = Date.now()
        cloud.lastSeenAt = new Date(heardAt).toISOString()
      }
      // Covers the handshake as well: a socket that never says ready is dropped like a half-open one.
      const heartbeat = setInterval(() => {
        if (Date.now() - heardAt > PONG_TIMEOUT_MS) socket.terminate()
        else if (socket.readyState === WebSocket.OPEN) socket.ping()
      }, PING_INTERVAL_MS)
      const teardown = () => {
        clearInterval(heartbeat)
        if (cloud.live?.socket === socket) cloud.live = null
        for (const answer of pending.values()) answer(offline(name))
        pending.clear()
      }
      const socket = dial(cloud.environment, token, {
        onFrame: (frame) => {
          heard()
          if (frame.type === "ready") {
            if (frame.version !== REMOTE_PROTOCOL_VERSION) {
              incompatible = true
              return socket.close()
            }
            connectedAt = Date.now()
            cloud.live = { socket, pending }
            runFork(setStatus(cloud, "connected"))
          } else if (frame.type === "result") {
            pending.get(frame.id)?.("error" in frame.envelope ? frame.envelope : { result: frame.envelope.result })
            pending.delete(frame.id)
          } else {
            learnFromPush(owners, id, frame.event)
            runFork(windows.send(frame.event))
          }
        },
        onUndecodable: () => runFork(Effect.logWarning("dropped an undecodable frame", name)),
        onPong: heard,
        onClose: (code) => {
          teardown()
          resume(
            Effect.succeed({ code, incompatible, connectedMs: connectedAt === null ? 0 : Date.now() - connectedAt }),
          )
        },
      })
      return Effect.sync(() => {
        teardown()
        socket.terminate()
      })
    })

  /** Keeps `cloud` connected until interrupted, refused, or speaking another protocol version. */
  const maintain = (cloud: Cloud) =>
    Effect.gen(function* () {
      const token = Option.getOrNull(yield* secrets.get(tokenSecret(cloud.environment.id)))
      if (token === null) return yield* setStatus(cloud, "unauthorized")
      yield* setStatus(cloud, "connecting")
      let attempt = 0
      for (;;) {
        const end = yield* session(cloud, token)
        if (end.incompatible) return yield* setStatus(cloud, "incompatible")
        if (end.code === CLOSE_UNAUTHORIZED) return yield* setStatus(cloud, "unauthorized")
        yield* setStatus(cloud, "offline")
        if (end.connectedMs >= STABLE_MS) attempt = 0
        yield* Effect.sleep(jittered(RECONNECT_DELAYS_MS[Math.min(attempt, RECONNECT_DELAYS_MS.length - 1)]!))
        attempt++
      }
    }).pipe(Effect.catchCause((cause) => Effect.logWarning("environment connection stopped", cause)))

  const connections = yield* FiberMap.make<string>()

  const start = (environment: Environment) =>
    Effect.suspend(() => {
      const existing = clouds.get(environment.id)
      const cloud: Cloud = existing ?? {
        environment,
        status: "connecting",
        lastSeenAt: null,
        live: null,
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
        return { ...row, status: cloud?.status ?? "offline", lastSeenAt: cloud?.lastSeenAt ?? null }
      }),
    }
  })

  const add = (input: { readonly name: string; readonly pairingUrl: string }) =>
    Effect.gen(function* () {
      const target = parsePairingUrl(input.pairingUrl)
      if (target === null) {
        return yield* new InvalidPairingUrl({ message: "Paste the kkcode://connect URL that kkcode serve printed." })
      }
      const ready = yield* probe(target)
      if (ready.environment?.id === self.id) {
        return yield* new InvalidPairingUrl({ message: "That pairing URL is for this desktop." })
      }
      const typed = input.name.trim()
      const id = ready.environment?.id ?? randomUUID()
      const existing = Option.getOrNull(yield* findOne(id).pipe(Effect.mapError(persistence("environments.add"))))
      const environment: Environment = existing
        ? { ...existing, name: typed || existing.name, host: target.host, port: target.port }
        : {
            id,
            name: typed || ready.environment?.name || target.host,
            host: target.host,
            port: target.port,
            createdAt: new Date().toISOString(),
          }
      const write = existing
        ? sql`UPDATE environment SET name = ${environment.name}, host = ${environment.host}, port = ${environment.port} WHERE id = ${id}`
        : sql`INSERT INTO environment ${sql.insert(environment)}`
      yield* write.pipe(
        Effect.andThen(secrets.set(tokenSecret(id), target.token)),
        sql.withTransaction,
        Effect.catchTag("SqlError", (error) => Effect.fail(persistence("environments.add")(error))),
      )
      yield* start(environment)
      return environment
    })

  const remove = (id: string) =>
    Effect.gen(function* () {
      yield* FiberMap.remove(connections, id)
      yield* sql`DELETE FROM environment WHERE id = ${id}`.pipe(Effect.mapError(persistence("environments.remove")))
      yield* secrets.clear(tokenSecret(id))
      clouds.delete(id)
      owners.forget(id)
    })

  const forward = (environmentId: string, { method, payload }: ForwardedCall) =>
    Effect.suspend(() => {
      const cloud = clouds.get(environmentId)
      if (cloud === undefined) return Effect.succeed(unknownEnvironment(environmentId))
      const live = cloud.live
      if (live === null) return Effect.succeed(offline(cloud.environment.name))
      return Effect.callback<RpcEnvelope<unknown>>((resume) => {
        const id = nextCallId++
        live.pending.set(id, (envelope) => resume(Effect.succeed(envelope)))
        live.socket.send(JSON.stringify({ type: "call", id, method, payload } satisfies ClientFrame))
        return Effect.sync(() => void live.pending.delete(id))
      }).pipe(
        Effect.map((envelope) => {
          if ("error" in envelope) return envelope
          learnFromAnswer(owners, environmentId, method, payload, envelope.result)
          const result = projectAnswers.has(method) ? stamp(envelope.result, environmentId) : envelope.result
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
        Effect.map(Effect.timeoutOption(forward(cloud.environment.id, call), GATHER_TIMEOUT), (answer) => {
          const envelope = Option.getOrUndefined(answer)
          if (envelope !== undefined && "result" in envelope && Array.isArray(envelope.result)) return envelope.result
          const last = cloud.remembered.get(call.method)
          return last?.payload === JSON.stringify(call.payload ?? null) && Array.isArray(last.result) ? last.result : []
        }),
      { concurrency: "unbounded" },
    ).pipe(Effect.map((answers) => answers.flat()))

  yield* Effect.forEach(yield* findAll(undefined).pipe(Effect.mapError(persistence("environments.load"))), start)

  return Environments.of({ list, add, remove, forward, gather, owner: owners.owner })
})

export const layer = Layer.effect(Environments, make)
