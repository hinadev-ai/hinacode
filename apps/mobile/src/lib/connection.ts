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
import { learnFromAnswer, learnFromPush, makeOwners, type Owners, stampEnvironment } from "@shared/owners.ts"
import { dialPlan, pairingUrl, parsePairingUrl } from "@shared/remote.ts"
import { type Entity, routes } from "@shared/routes.ts"
import { copy } from "./copy"
import type { StoredServer } from "./stored-target"
import {
  CONNECT_TIMEOUT_MS,
  PROBE_TIMEOUT_MS,
  RpcError,
  Transport,
  type TransportMessages,
  type TransportStatus,
} from "@shared/transport.ts"

export { RpcError } from "@shared/transport.ts"

export type ConnectionStatus = TransportStatus

export interface Server extends StoredServer {
  readonly status: ConnectionStatus
  readonly error: string | null
  readonly features: ReadonlySet<string>
  readonly generation: number
  readonly listed: boolean
}

interface ConnectionState {
  readonly servers: readonly Server[]
  readonly paired: boolean
  readonly status: ConnectionStatus
  readonly generation: number
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
let foreground = true
let watching: readonly string[] = []
const owners = makeOwners()
export type RememberedAnswers = Readonly<Partial<Record<RpcMethod, { readonly payload: string; readonly result: unknown }>>>

const remembered = new Map<string, RememberedAnswers>()
const listsShownAtLaunch: readonly RpcMethod[] = ["projects.list", "threads.list", "worktrees.list", "pullRequests.all"]
const savedAtLaunch = (answers: RememberedAnswers): RememberedAnswers =>
  Object.fromEntries(listsShownAtLaunch.flatMap((method) => (answers[method] ? [[method, answers[method]]] : [])))
const rememberListeners = new Set<(serverId: string, answers: RememberedAnswers) => void>()
const listeners = new Set<(event: PushEvent) => void>()

export function restoreAnswers(serverId: string, answers: RememberedAnswers) {
  if (remembered.has(serverId) || !useConnection.getState().servers.some((server) => server.id === serverId)) return
  remembered.set(serverId, answers)
  const unclaimed: Owners = {
    ...owners,
    teach: (environmentId, entity, id) => {
      if (owners.owner(entity, id) === undefined) owners.teach(environmentId, entity, id)
    },
  }
  for (const method of ["projects.list", "threads.list", "worktrees.list"] as const)
    learnFromAnswer(unclaimed, serverId, method, undefined, answers[method]?.result)
}

export function onRemembered(listener: (serverId: string, answers: RememberedAnswers) => void) {
  rememberListeners.add(listener)
  return () => {
    rememberListeners.delete(listener)
  }
}

const sameTarget = (a: StoredServer, b: StoredServer) => a.port === b.port && a.token === b.token

const sameDials = (a: StoredServer, b: StoredServer) => a.relay === b.relay && a.hosts.join(" ") === b.hosts.join(" ")

const transportMessages: TransportMessages = {
  notSent: copy("mobile_transport_not_sent"),
  mayHaveRun: copy("mobile_transport_may_have_run"),
  lostReply: copy("mobile_transport_lost_reply"),
  disconnected: copy("mobile_transport_disconnected"),
  notConnected: copy("mobile_transport_not_connected"),
  tokenRotated: copy("mobile_transport_token_rotated"),
  tokenRefused: copy("mobile_transport_token_refused"),
  protocolMismatch: (server, client) =>
    copy("mobile_transport_protocol_mismatch", { desktop: String(server), app: String(client) }),
}

function open(server: StoredServer) {
  const transport = new Transport({
    dials: dialPlan(server),
    token: server.token,
    messages: transportMessages,
    compact: true,
    isMutation: (method) => mutations.has(method),
    onStatus: (status, error) => {
      if (transports.get(server.id) === transport) updateServer(server.id, { status, error })
    },
    onReady: (features, environment, relay, reported) => {
      if (transports.get(server.id) !== transport) return
      updateServer(server.id, (current) => ({
        features,
        generation: current.generation + 1,
        name: current.name ?? environment?.name ?? null,
        environmentId: environment?.id ?? current.environmentId,
      }))
      const { servers } = useConnection.getState()
      const olderPairingOfSameMachine = servers.find(
        (other) => other.id !== server.id && environment !== undefined && other.environmentId === environment.id,
      )
      const self = servers.find((other) => other.id === server.id)
      if (self === undefined) return
      const hosts =
        reported === undefined ? self.hosts : (parsePairingUrl(pairingUrl({ ...self, hosts: reported }))?.hosts ?? self.hosts)
      if (olderPairingOfSameMachine !== undefined || !sameDials(self, { ...self, relay, hosts }))
        setServers(
          servers
            .filter((other) => other !== olderPairingOfSameMachine)
            .map((other) => (other === self ? { ...other, relay, hosts } : other)),
        )
    },
    onEvent: (event) => {
      learnFromPush(owners, server.id, event)
      for (const listener of Array.from(listeners)) listener(event)
    },
  })
  transports.set(server.id, transport)
  transport.setForeground(foreground)
  transport.setWatching(watching)
  transport.start()
}

function close(id: string) {
  transports.get(id)?.stop()
  transports.delete(id)
  owners.forget(id)
  remembered.delete(id)
}

const toStored = ({ id, name, environmentId, hosts, port, token, relay, source }: StoredServer): StoredServer => ({
  id,
  name,
  environmentId,
  hosts,
  port,
  token,
  relay,
  source,
})

export const storedServers = () => useConnection.getState().servers.map(toStored)

export function setServers(servers: readonly StoredServer[]) {
  const previous = new Map(useConnection.getState().servers.map((server) => [server.id, server]))
  for (const id of previous.keys()) if (!servers.some((server) => server.id === id)) close(id)
  const next = servers.map((server): Server => {
    const existing = previous.get(server.id)
    const stored = toStored(server)
    if (existing !== undefined && sameTarget(existing, server)) {
      if (!sameDials(existing, server)) transports.get(server.id)?.setDials(dialPlan(server))
      return { ...existing, ...stored }
    }
    if (existing !== undefined) close(server.id)
    return {
      ...stored,
      status: foreground ? "connecting" : "offline",
      error: null,
      features: new Set(),
      generation: 0,
      listed: false,
    }
  })
  useConnection.setState(summarize(next))
  for (const server of next) if (!transports.has(server.id)) open(server)
}

export function reconnectNow(id?: string) {
  for (const [serverId, transport] of transports) if (id === undefined || id === serverId) transport.reconnectNow()
}

export const networkChanged = () => transports.forEach((transport) => transport.networkChanged())

export function setForeground(active: boolean) {
  foreground = active
  transports.forEach((transport) => transport.setForeground(active))
}

export function setWatching(threadIds: readonly string[]) {
  watching = threadIds
  transports.forEach((transport) => transport.setWatching(threadIds))
}

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

const ownersSettled = () =>
  useConnection
    .getState()
    .servers.every((server) => server.listed || server.status === "offline" || server.status === "unauthorized")

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

const offline = () => new RpcError("Offline", copy("mobile_connection_no_server"))

async function send(serverId: string, method: RpcMethod, payload: unknown): Promise<RpcEnvelope<unknown>> {
  const transport = transports.get(serverId)
  if (transport === undefined) throw offline()
  const envelope = await transport.call(method, payload)
  if ("error" in envelope) return envelope
  learnFromAnswer(owners, serverId, method, payload, envelope.result)
  if (method === "threads.list") updateServer(serverId, { listed: true })
  return { result: stampEnvironment(method, envelope.result, serverId) }
}

const failureOf = (cause: unknown): RpcEnvelope<never> =>
  cause instanceof RpcError
    ? { error: { tag: cause.tag, message: cause.message } }
    : { error: { tag: "Offline", message: String(cause) } }

async function gather(method: RpcMethod, payload: unknown): Promise<RpcEnvelope<unknown>> {
  const key = JSON.stringify(payload ?? null)
  const answers = await Promise.all(
    useConnection.getState().servers.map(async (server): Promise<RpcEnvelope<unknown[]> | undefined> => {
      const last = remembered.get(server.id)?.[method]
      const fallback = last?.payload === key && Array.isArray(last.result) ? { result: last.result } : undefined
      if (server.status !== "connected") return fallback
      const envelope = await Promise.race([
        send(server.id, method, payload).catch(failureOf),
        new Promise<undefined>((resolve) => setTimeout(resolve, PROBE_TIMEOUT_MS)),
      ])
      if (envelope !== undefined && "error" in envelope) return fallback ?? envelope
      if (envelope === undefined || !Array.isArray(envelope.result)) return fallback
      const answers = { ...remembered.get(server.id), [method]: { payload: key, result: envelope.result } }
      remembered.set(server.id, answers)
      if (listsShownAtLaunch.includes(method))
        for (const listener of rememberListeners) listener(server.id, savedAtLaunch(answers))
      return { result: envelope.result }
    }),
  )
  const lists = answers.filter((answer) => answer !== undefined && "result" in answer)
  const failure = answers.find((answer) => answer !== undefined && "error" in answer)
  if (lists.length === 0 && failure !== undefined) return failure
  return { result: lists.flatMap((answer) => answer.result) }
}

async function dispatch(method: RpcMethod, payload: unknown, named: string | undefined) {
  const route = routes[method]
  const { servers } = useConnection.getState()
  if (servers.length === 0) throw offline()
  if (route.to === "all") return gather(method, payload)
  if (route.to === "owner" && servers.length > 1) {
    const id = payloadId(payload, route.key)
    const known = id === undefined ? undefined : owners.owner(route.entity, id)
    const owner = known ?? named ?? (id === undefined ? null : await findOwner(route.entity, id))
    if (owner === null) throw new RpcError("NotFoundError", copy("mobile_connection_server_gone"))
    return send(owner, method, payload)
  }
  const target =
    servers.find((server) => server.id === named) ??
    servers.find((server) => server.status === "connected") ??
    servers[0]!
  return send(target.id, method, payload)
}

export function request<M extends RpcMethod>(
  method: M,
  payload: RpcRequest<M>,
  options?: { readonly server?: string },
): Effect.Effect<RpcResponse<M>, RpcError> {
  const spec = RpcMethods[method]
  const encodeRequest = Schema.encodeEffect(spec.request)
  const decodeResponse = Schema.decodeUnknownEffect(spec.response)
  return Effect.gen(function* () {
    const encoded = yield* encodeRequest(payload)
    const envelope = yield* Effect.tryPromise({
      try: () => dispatch(method, encoded, options?.server),
      catch: (cause) => (cause instanceof RpcError ? cause : new RpcError("Offline", String(cause))),
    })
    if ("error" in envelope) return yield* Effect.fail(new RpcError(envelope.error.tag, envelope.error.message))
    return yield* decodeResponse(envelope.result)
  }).pipe(
    Effect.catchTag("SchemaError", (error) => Effect.fail(new RpcError(error._tag, error.message))),
  ) as Effect.Effect<RpcResponse<M>, RpcError>
}

export const call = <M extends RpcMethod>(method: M, payload: RpcRequest<M>, options?: { readonly server?: string }) =>
  Effect.runPromise(request(method, payload, options))
