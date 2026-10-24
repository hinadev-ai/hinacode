import { Array as Arr, Schema } from "effect"
import { isArrayNonEmpty, type NonEmptyReadonlyArray } from "effect/Array"
import { PushEvent } from "./contract.ts"

/** Path the phone upgrades to a WebSocket on. */
export const REMOTE_PATH = "/remote"

/** Bumped when a frame changes shape, so an old phone app says "update" instead of failing oddly. */
export const REMOTE_PROTOCOL_VERSION = 1

/** The listener closes a socket whose unsent output grows past this, so no single answer may be larger. */
export const SLOW_CONSUMER_BYTES = 8 * 1024 * 1024

export const RemoteFeature = ["heartbeat", "call-keys", "terminal-attach"] as const
export type RemoteFeature = (typeof RemoteFeature)[number]

/** Phone -> desktop. The first frame on a socket must be `auth`. */
export const ClientFrame = Schema.Union([
  Schema.Struct({ type: Schema.Literal("auth"), token: Schema.String }),
  /** `payload` is absent for methods that take nothing, since JSON has no undefined. */
  Schema.Struct({
    type: Schema.Literal("call"),
    id: Schema.Int,
    method: Schema.String,
    payload: Schema.optionalKey(Schema.Unknown),
    key: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({ type: Schema.Literal("ping"), at: Schema.Number }),
])
export type ClientFrame = typeof ClientFrame.Type

const Failure = Schema.Struct({ tag: Schema.String, message: Schema.String })

/**
 * Desktop -> phone. `result` answers one `call`; `event` is the same push the desktop renderer gets.
 * A method that returns nothing answers with `envelope: {}`, since JSON drops an undefined `result`.
 */
export const ServerFrame = Schema.Union([
  /**
   * `environment` names the hinacode that answered, so a desktop pairing it twice keeps one entry. Older ones omit it.
   * `relay` is its tunnel hostname, absent when it has none, so a client paired before the relay existed learns it.
   */
  Schema.Struct({
    type: Schema.Literal("ready"),
    version: Schema.Int,
    environment: Schema.optionalKey(Schema.Struct({ id: Schema.String, name: Schema.String })),
    features: Schema.optionalKey(Schema.Array(Schema.String)),
    relay: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal("result"),
    id: Schema.Int,
    envelope: Schema.Union([
      Schema.Struct({ error: Failure }),
      Schema.Struct({ result: Schema.optionalKey(Schema.Unknown) }),
    ]),
  }),
  Schema.Struct({ type: Schema.Literal("event"), event: PushEvent }),
  Schema.Struct({ type: Schema.Literal("pong"), at: Schema.Number }),
])
export type ServerFrame = typeof ServerFrame.Type

/**
 * A pairing reaches one desktop on any of `hosts`, tried in order, or from any network through `relay`, the
 * hostname of its Cloudflare tunnel.
 */
export interface PairingTarget {
  readonly hosts: NonEmptyReadonlyArray<string>
  readonly port: number
  readonly token: string
  readonly relay: string | null
}

/** The text the pairing QR code carries, as `hinacode://connect?relay=&host=a&host=b&port=&token=`. */
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

/** Cloudflare's edge serves a tunnel on 443 only. */
export const relayWebSocketUrl = (relay: string) => `wss://${relay}${REMOTE_PATH}`

/** One socket URL a client dials in a round, and how long after the round starts. */
export interface Dial {
  readonly url: string
  readonly route: "direct" | "relay"
  readonly delayMs: number
}

/** How long the relay waits behind the direct addresses, so one on this network wins whenever it answers. */
export const RELAY_DELAY_MS = 500

/** While connected through the relay, how often a client checks whether a direct address answers again. */
export const DIRECT_CHECK_INTERVAL_MS = 60_000

/** How long that check waits for a direct address to open. */
export const DIRECT_CHECK_TIMEOUT_MS = 2_000

/**
 * What a client dials to reach a pairing: every direct address at once, then the relay after `RELAY_DELAY_MS`. The
 * first socket to open wins and the others close, so the pairing token goes to that socket only.
 */
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

/**
 * Reads a pairing URL back, keeping the order of repeated `host`s. Accepts it inside other text, such as the
 * lines `hinacode serve` prints around it, by reading the first `hinacode://connect?` word. Null when that
 * word is missing or is not a complete `hinacode://connect` URL.
 */
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

/** Whether a listener's `listenError` means another program holds the port. Node puts the code in the message. */
export const isPortInUse = (listenError: string) => listenError.includes("EADDRINUSE")
