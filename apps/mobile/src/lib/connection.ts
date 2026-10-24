import { Effect, Schema } from "effect"
import { create } from "zustand"
import {
  mutations,
  type PushEvent,
  type RpcEnvelope,
  type RpcMethod,
  RpcMethods,
  type RpcRequest,
  type RpcResponse,
} from "@shared/contract.ts"
import { learnFromAnswer, learnFromPush, makeOwners, stampProjects } from "@shared/owners.ts"
import { remoteSocketUrls } from "@shared/remote.ts"
import { type Entity, routes } from "@shared/routes.ts"
import type { StoredServer } from "./stored-target"
import { CONNECT_TIMEOUT_MS, PROBE_TIMEOUT_MS, RpcError, Transport, type TransportStatus } from "./transport"

export { RpcError } from "./transport"

export type ConnectionStatus = TransportStatus

export interface Server extends StoredServer {
  readonly status: ConnectionStatus
  /** Why the server refused us, shown in Settings and on the pairing screen. */
  readonly error: string | null
  /** What the server of the latest handshake understands, e.g. `terminal-attach`. */
  readonly features: ReadonlySet<string>
  /** Counts this server's successful handshakes. */
  readonly generation: number
  /** Whether this server has answered `threads.list` since the app started, so the ids it owns are known. */
  readonly listed: boolean
}

interface ConnectionState {
  /** In the order they were paired. */
  readonly servers: readonly Server[]
  /** Whether any server would still take a call. */
  readonly paired: boolean
  /** The best status of any server, for code that only asks whether anything is connected. */
  readonly status: ConnectionStatus
  /** Counts every server's handshakes. Snapshots are reloaded after each one, since pushes sent meanwhile are lost. */
  readonly generation: number
  /** What every connected server understands. */
  readonly features: ReadonlySet<string>
}

const statusRank: Record<ConnectionStatus, number> = { connected: 3, connecting: 2, offline: 1, unauthorized: 0 }

const summarize = (servers: readonly Server[]): ConnectionState => {
  const connected = servers.filter((server) => server.status === "connected")
  return {
    servers,
    paired: servers.some((server) => server.status !== "unauthorized"),
    status: servers.reduce<ConnectionStatus>(
      (best, server) => (statusRank[server.status] > statusRank[best] ? server.status : best),
      servers.length === 0 ? "offline" : "unauthorized",
    ),
    generation: servers.reduce((sum, server) => sum + server.generation, 0),
    features:
      connected.length === 0
        ? new Set()
        : new Set(
            [...connected[0]!.features].filter((feature) => connected.every((server) => server.features.has(feature))),
          ),
  }
}

export const useConnection = create<ConnectionState>()(() => summarize([]))

const updateServer = (id: string, patch: Partial<Server> | ((server: Server) => Partial<Server>)) =>
  useConnection.setState((state) =>
    summarize(
      state.servers.map((server) =>
        server.id === id ? { ...server, ...(typeof patch === "function" ? patch(server) : patch) } : server,
      ),
    ),
  )

const transports = new Map<string, Transport>()
const owners = makeOwners()
/** Each server's last answer to an `all` method, listed while it is offline. */
const remembered = new Map<string, Map<RpcMethod, { readonly payload: string; readonly result: unknown }>>()
const listeners = new Set<(event: PushEvent) => void>()

const sameTarget = (a: StoredServer, b: StoredServer) =>
  a.port === b.port && a.token === b.token && a.hosts.join(" ") === b.hosts.join(" ")

function open(server: StoredServer) {
  const transport = new Transport({
    urls: remoteSocketUrls(server),
    token: server.token,
    isMutation: (method) => mutations.has(method),
    onStatus: (status, error) => {
      if (transports.get(server.id) === transport) updateServer(server.id, { status, error })
    },
    onReady: (features, environment, relay) => {
      if (transports.get(server.id) !== transport) return
      updateServer(server.id, (current) => ({
        features,
        generation: current.generation + 1,
        name: current.name ?? environment?.name ?? null,
        environmentId: environment?.id ?? current.environmentId,
      }))
      const { servers } = useConnection.getState()
      // The same machine paired again at another address: the older entry goes.
      const older = servers.find(
        (other) => other.id !== server.id && environment !== undefined && other.environmentId === environment.id,
      )
      // A relay set up or removed since pairing.
      if (older !== undefined || relay !== servers.find((other) => other.id === server.id)?.relay)
        setServers(
          servers
            .filter((other) => other !== older)
            .map((other) => (other.id === server.id ? { ...other, relay } : other)),
        )
    },
    onEvent: (event) => {
      learnFromPush(owners, server.id, event)
      for (const listener of listeners) listener(event)
    },
  })
  transports.set(server.id, transport)
  transport.start()
}

function close(id: string) {
  transports.get(id)?.stop()
  transports.delete(id)
  owners.forget(id)
  remembered.delete(id)
}

/**
 * Keeps one socket open to each of `servers`: opens the new ones, closes the ones no longer listed, redials a
 * server whose addresses or token changed, and points one whose relay changed at the new URLs without dropping
 * its socket. Callers persist the list from `useConnection` themselves.
 */
export function setServers(servers: readonly StoredServer[]) {
  const previous = new Map(useConnection.getState().servers.map((server) => [server.id, server]))
  for (const id of previous.keys()) if (!servers.some((server) => server.id === id)) close(id)
  const next = servers.map((server): Server => {
    const existing = previous.get(server.id)
    const { id, name, environmentId, hosts, port, token, relay } = server
    const stored = { id, name, environmentId, hosts, port, token, relay }
    if (existing !== undefined && sameTarget(existing, server)) {
      // Only the relay changed: the open socket and the calls waiting on it stay.
      if (existing.relay !== relay) transports.get(id)?.setUrls(remoteSocketUrls(server))
      return { ...existing, ...stored }
    }
    if (existing !== undefined) close(server.id)
    return { ...stored, status: "connecting", error: null, features: new Set(), generation: 0, listed: false }
  })
  useConnection.setState(summarize(next))
  for (const server of next) if (!transports.has(server.id)) open(server)
}

/** Skips the remaining backoff of one server, or of all. */
export function reconnectNow(id?: string) {
  for (const [serverId, transport] of transports) if (id === undefined || id === serverId) transport.reconnectNow()
}

/** The device switched networks, so the current sockets are probably dead even if they look open. */
export const networkChanged = () => transports.forEach((transport) => transport.networkChanged())

export const setForeground = (foreground: boolean) =>
  transports.forEach((transport) => transport.setForeground(foreground))

export function onEvent(listener: (event: PushEvent) => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

const payloadId = (payload: unknown, key: string) => {
  const value = typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>)[key] : undefined
  return typeof value === "string" ? value : undefined
}

/** Whether every server has listed its threads or cannot, so an id none of them claimed belongs to none. */
const ownersSettled = () =>
  useConnection
    .getState()
    .servers.every((server) => server.listed || server.status === "offline" || server.status === "unauthorized")

/** The server that owns `id`, waiting until the servers have listed what they own. */
function findOwner(entity: Entity, id: string): Promise<string | null> {
  const check = () => owners.owner(entity, id) ?? (ownersSettled() ? null : undefined)
  const now = check()
  if (now !== undefined) return Promise.resolve(now)
  return new Promise((resolve) => {
    const done = (owner: string | null) => {
      unsubscribe()
      clearTimeout(timer)
      resolve(owner)
    }
    const timer = setTimeout(() => done(owners.owner(entity, id) ?? null), CONNECT_TIMEOUT_MS)
    const unsubscribe = useConnection.subscribe(() => {
      const owner = check()
      if (owner !== undefined) done(owner)
    })
  })
}

const offline = () => new RpcError("Offline", "Not connected to any server.")

/** Sends one call to one server and learns the ids in its answer. */
async function send(serverId: string, method: RpcMethod, payload: unknown): Promise<RpcEnvelope<unknown>> {
  const transport = transports.get(serverId)
  if (transport === undefined) throw offline()
  const envelope = await transport.call(method, payload)
  if ("error" in envelope) return envelope
  learnFromAnswer(owners, serverId, method, payload, envelope.result)
  if (method === "threads.list") updateServer(serverId, { listed: true })
  return { result: stampProjects(method, envelope.result, serverId) }
}

/**
 * Asks every connected server and concatenates the lists. A server that is not connected, or does not answer
 * within a few seconds, adds its last answer to the same call, so its threads stay listed while it is away.
 */
async function gather(method: RpcMethod, payload: unknown): Promise<RpcEnvelope<unknown>> {
  const key = JSON.stringify(payload ?? null)
  const answers = await Promise.all(
    useConnection.getState().servers.map(async (server) => {
      const last = remembered.get(server.id)?.get(method)
      const fallback = last?.payload === key && Array.isArray(last.result) ? last.result : []
      if (server.status !== "connected") return fallback
      const envelope = await Promise.race([
        send(server.id, method, payload).catch(() => undefined),
        new Promise<undefined>((resolve) => setTimeout(resolve, PROBE_TIMEOUT_MS)),
      ])
      if (envelope === undefined || "error" in envelope || !Array.isArray(envelope.result)) return fallback
      remembered.set(
        server.id,
        (remembered.get(server.id) ?? new Map()).set(method, { payload: key, result: envelope.result }),
      )
      return envelope.result
    }),
  )
  return { result: answers.flat() }
}

/** Where a call goes, by the route table the desktop uses (`src/shared/routes.ts`). */
async function dispatch(method: RpcMethod, payload: unknown, named: string | undefined) {
  const route = routes[method]
  const { servers } = useConnection.getState()
  if (servers.length === 0) throw offline()
  if (route.to === "all") return gather(method, payload)
  if (route.to === "owner" && servers.length > 1) {
    const id = payloadId(payload, route.key)
    const owner = id === undefined ? null : await findOwner(route.entity, id)
    if (owner === null) throw new RpcError("NotFoundError", "No paired server has this anymore.")
    return send(owner, method, payload)
  }
  const target =
    servers.find((server) => server.id === named) ??
    servers.find((server) => server.status === "connected") ??
    servers[0]!
  return send(target.id, method, payload)
}

/**
 * Calls the server that owns the call's ids, every server for a list, or `options.server` for a call that names
 * one (Add project, settings); unnamed, that is the first connected server. While a server's link is down the
 * call waits and is sent after its next handshake, so it runs once. Rejects with `RpcError` carrying the
 * handler's error tag, or `Timeout` after a minute offline.
 */
export function call<M extends RpcMethod>(
  method: M,
  payload: RpcRequest<M>,
  options?: { readonly server?: string },
): Promise<RpcResponse<M>> {
  const spec = RpcMethods[method]
  const encodeRequest = Schema.encodeEffect(spec.request)
  const decodeResponse = Schema.decodeUnknownEffect(spec.response)
  return Effect.runPromise(
    Effect.gen(function* () {
      const encoded = yield* encodeRequest(payload)
      const envelope = yield* Effect.tryPromise({
        try: () => dispatch(method, encoded, options?.server),
        catch: (cause) => (cause instanceof RpcError ? cause : new RpcError("Offline", String(cause))),
      })
      if ("error" in envelope) return yield* Effect.fail(new RpcError(envelope.error.tag, envelope.error.message))
      return yield* decodeResponse(envelope.result)
    }).pipe(
      Effect.catchTag("SchemaError", (error) => Effect.fail(new RpcError(error._tag, error.message))),
    ) as Effect.Effect<RpcResponse<M>, RpcError>,
  )
}
