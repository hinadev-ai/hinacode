import { Array as Arr, Schema } from "effect"
import { isArrayNonEmpty, type NonEmptyReadonlyArray } from "effect/Array"
import { PushEvent, type RpcMethod } from "./contract.ts"

export const REMOTE_PATH = "/remote"

export const REMOTE_PROTOCOL_VERSION = 1

export const RemoteFeature = ["heartbeat", "call-keys", "terminal-attach", "asks", "watch"] as const
export type RemoteFeature = (typeof RemoteFeature)[number]

export const AskableMethod = Schema.Literals([
  "threads.list",
  "projects.list",
  "worktrees.list",
  "threads.transcript",
  "pullRequests.list",
  "machines.list",
  "threads.create",
  "threads.update",
  "threads.steer",
  "threads.interrupt",
] satisfies ReadonlyArray<RpcMethod>)
export type AskableMethod = typeof AskableMethod.Type

const Failure = Schema.Struct({ tag: Schema.String, message: Schema.String })

const Envelope = Schema.Union([
  Schema.Struct({ error: Failure }),
  Schema.Struct({ result: Schema.optionalKey(Schema.Unknown) }),
])

export const ClientFrame = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("auth"),
    nonce: Schema.String,
    proof: Schema.String,
    compactEvents: Schema.optionalKey(Schema.Boolean),
  }),
  Schema.Struct({
    type: Schema.Literal("auth"),
    token: Schema.String,
    compactEvents: Schema.optionalKey(Schema.Boolean),
  }),
  Schema.Struct({
    type: Schema.Literal("call"),
    id: Schema.Int,
    method: Schema.String,
    payload: Schema.optionalKey(Schema.Unknown),
    key: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({ type: Schema.Literal("ping"), at: Schema.Number }),
  Schema.Struct({ type: Schema.Literal("hub") }),
  Schema.Struct({ type: Schema.Literal("answer"), id: Schema.Int, envelope: Envelope }),
  Schema.Struct({ type: Schema.Literal("watch"), threadIds: Schema.Array(Schema.String) }),
])
export type ClientFrame = typeof ClientFrame.Type

export const ServerFrame = Schema.Union([
  Schema.Struct({ type: Schema.Literal("challenge"), nonce: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("ready"),
    version: Schema.Int,
    environment: Schema.optionalKey(Schema.Struct({ id: Schema.String, name: Schema.String })),
    features: Schema.optionalKey(Schema.Array(Schema.String)),
    relay: Schema.optionalKey(Schema.String),
    proof: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({ type: Schema.Literal("result"), id: Schema.Int, envelope: Envelope }),
  Schema.Struct({ type: Schema.Literal("event"), event: PushEvent }),
  Schema.Struct({ type: Schema.Literal("pong"), at: Schema.Number }),
  Schema.Struct({
    type: Schema.Literal("ask"),
    id: Schema.Int,
    method: AskableMethod,
    payload: Schema.optionalKey(Schema.Unknown),
  }),
])
export type ServerFrame = typeof ServerFrame.Type

const noticeEvents: ReadonlySet<string> = new Set([
  "turn_completed",
  "turn_failed",
  "turn_limited",
  "approval_requested",
  "question_requested",
  "secret_requested",
])

const transcriptThreadId = (event: typeof PushEvent.Encoded) =>
  event.type === "thread.event"
    ? event.threadId
    : event.type === "message.created" || event.type === "message.updated"
      ? event.message.threadId
      : undefined

export const reachesPhone = (event: typeof PushEvent.Encoded, watching: ReadonlySet<string> | null) => {
  if (event.type === "thread.event" && noticeEvents.has(event.event.type)) return true
  const threadId = transcriptThreadId(event)
  return threadId === undefined || watching === null || watching.has(threadId)
}

export interface PairingTarget {
  readonly hosts: NonEmptyReadonlyArray<string>
  readonly port: number
  readonly token: string
  readonly relay: string | null
}

export const pairingUrl = ({ hosts, port, token, relay }: PairingTarget) => {
  const url = new URL("hinacode://connect")
  if (relay !== null) url.searchParams.set("relay", relay)
  for (const host of hosts) url.searchParams.append("host", host)
  url.searchParams.set("port", String(port))
  url.searchParams.set("token", token)
  return url.toString()
}

export const remoteWebSocketUrl = ({ host, port }: { readonly host: string; readonly port: number }) =>
  `ws://${host.includes(":") ? `[${host}]` : host}:${port}${REMOTE_PATH}`

// FIXME: Cloudflare serves a tunnel on port 443 only
export const relayWebSocketUrl = (relay: string) => `wss://${relay}${REMOTE_PATH}`

export interface Dial {
  readonly url: string
  readonly route: "direct" | "relay"
  readonly delayMs: number
}

export const RELAY_DELAY_MS = 500

export const DIRECT_CHECK_INTERVAL_MS = 60_000

export const DIRECT_CHECK_TIMEOUT_MS = 2_000

export const CHALLENGE_WAIT_MS = 1_000

export const dialPlan = (target: Omit<PairingTarget, "token">): NonEmptyReadonlyArray<Dial> => {
  const direct = Arr.map(target.hosts, (host): Dial => ({
    url: remoteWebSocketUrl({ host, port: target.port }),
    route: "direct",
    delayMs: 0,
  }))
  return target.relay === null
    ? direct
    : Arr.append(direct, { url: relayWebSocketUrl(target.relay), route: "relay", delayMs: RELAY_DELAY_MS })
}

const isAuthorityOnlyHost = (host: string) =>
  host !== "" && !/[\s/?#@[\]\\]/.test(host) && URL.parse(remoteWebSocketUrl({ host, port: 1 })) !== null

const isRelayHostname = (relay: string) => /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(relay)

export const parsePairingUrl = (text: string): PairingTarget | null => {
  const word = text.split(/\s+/).find((part) => /^hinacode:\/\/connect\?/i.test(part))
  const url = word === undefined ? null : URL.parse(word)
  if (!url || url.protocol !== "hinacode:" || url.host !== "connect") return null
  const hosts = url.searchParams.getAll("host")
  const port = Number(url.searchParams.get("port"))
  const token = url.searchParams.get("token")
  const relay = url.searchParams.get("relay")
  if (!isArrayNonEmpty(hosts) || !hosts.every(isAuthorityOnlyHost)) return null
  if (!token || !Number.isInteger(port) || port < 1 || port > 65535) return null
  if (relay !== null && !isRelayHostname(relay)) return null
  return { hosts, port, token, relay }
}

export const isPortInUse = (listenError: string) => listenError.includes("EADDRINUSE")
