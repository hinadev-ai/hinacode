import { Array as Arr, Schema } from "effect"
import { isArrayNonEmpty, type NonEmptyReadonlyArray } from "effect/Array"
import { PushEvent, type RpcMethod } from "./contract.ts"
import { decodeKey } from "./noise.ts"

export const REMOTE_PATH = "/remote"

export const REMOTE_MAX_FRAME_BYTES = 16 * 1024 * 1024

export const REMOTE_SEALED_FRAME_BYTES = REMOTE_MAX_FRAME_BYTES + 16

export const REMOTE_PRE_READY_MAX_BYTES = 1024

export const REMOTE_PROTOCOL_VERSION = 2

export const CLOSE_UNAUTHORIZED = 4001
export const CLOSE_PAIRING_RESET = 4002
export const CLOSE_LISTENER_STOPPED = 4003
export const CLOSE_AUTH_TIMEOUT = 4004
export const CLOSE_MALFORMED_FRAME = 4005
export const CLOSE_HANDSHAKE_FAILED = 4006

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

const Nonce = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/))

export const DeviceName = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64))

export const ClientFrame = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("hello"),
    name: DeviceName,
    secret: Schema.optionalKey(Schema.String),
    verify: Schema.optionalKey(Schema.Boolean),
    compactEvents: Schema.optionalKey(Schema.Boolean),
  }),
  Schema.Struct({ type: Schema.Literal("approval"), nonce: Nonce }),
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
  Schema.Struct({ type: Schema.Literal("pending"), commitment: Nonce }),
  Schema.Struct({ type: Schema.Literal("approval"), nonce: Nonce }),
  Schema.Struct({
    type: Schema.Literal("ready"),
    version: Schema.Int,
    environment: Schema.optionalKey(Schema.Struct({ id: Schema.String, name: Schema.String })),
    features: Schema.optionalKey(Schema.Array(Schema.String)),
    hosts: Schema.optionalKey(Schema.NonEmptyArray(Schema.String)),
    relay: Schema.optionalKey(Schema.String),
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

export const LegacyChallenge = Schema.Struct({ type: Schema.Literal("challenge"), nonce: Schema.String })

export const LegacyAuth = Schema.Union([
  Schema.Struct({ type: Schema.Literal("auth"), nonce: Schema.String, proof: Schema.String }),
  Schema.Struct({ type: Schema.Literal("auth"), token: Schema.String }),
])
export type LegacyAuth = typeof LegacyAuth.Type

export const LegacyReady = Schema.Struct({
  type: Schema.Literal("ready"),
  version: Schema.Int,
  proof: Schema.optionalKey(Schema.String),
})

const CONFUSABLES: Readonly<Record<string, string>> = { O: "0", I: "1", L: "1" }

export const normalizeApprovalCode = (text: string): string | null => {
  const characters = text
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/[OIL]/g, (letter) => CONFUSABLES[letter]!)
  if (!/^[0-9A-HJKMNP-TV-Z]{6}$/.test(characters)) return null
  return `${characters.slice(0, 3)}-${characters.slice(3)}`
}

export const noticeEvents: ReadonlySet<string> = new Set([
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
  readonly relay: string | null
  readonly key: string
  readonly secret: string | null
}

export const pairingUrl = ({ hosts, port, relay, key, secret }: PairingTarget) => {
  const url = new URL("hinacode://connect")
  if (relay !== null) url.searchParams.set("relay", relay)
  for (const host of hosts) url.searchParams.append("host", host)
  url.searchParams.set("port", String(port))
  url.searchParams.set("key", key)
  if (secret !== null) url.searchParams.set("secret", secret)
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

export const TAILSCALE_DELAY_MS = 150

export const RELAY_DELAY_MS = 500

export const DIRECT_CHECK_INTERVAL_MS = 60_000

export const DIRECT_CHECK_TIMEOUT_MS = 2_000

export const isTailscaleHost = (host: string) => {
  const [first, second] = host.split(".")
  return first === "100" && Number(second) >= 64 && Number(second) <= 127
}

export const dialPlan = (target: Pick<PairingTarget, "hosts" | "port" | "relay">): NonEmptyReadonlyArray<Dial> => {
  const hasLan = !target.hosts.every(isTailscaleHost)
  const direct = Arr.map(target.hosts, (host): Dial => ({
    url: remoteWebSocketUrl({ host, port: target.port }),
    route: "direct",
    delayMs: hasLan && isTailscaleHost(host) ? TAILSCALE_DELAY_MS : 0,
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
  const key = url.searchParams.get("key")
  const secret = url.searchParams.get("secret") || null
  const relay = url.searchParams.get("relay")
  if (!isArrayNonEmpty(hosts) || !hosts.every(isAuthorityOnlyHost)) return null
  if (key === null || decodeKey(key) === null || !Number.isInteger(port) || port < 1 || port > 65535) return null
  if (relay !== null && !isRelayHostname(relay)) return null
  return { hosts, port, relay, key, secret }
}

export const isPortInUse = (listenError: string) => listenError.includes("EADDRINUSE")

export const isAddressNotUpYet = (listenError: string) => listenError.includes("EADDRNOTAVAIL")
