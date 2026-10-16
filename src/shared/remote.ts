import { Schema } from "effect"
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
  /** `environment` names the hinacode that answered, so a desktop pairing it twice keeps one entry. Older ones omit it. */
  Schema.Struct({
    type: Schema.Literal("ready"),
    version: Schema.Int,
    environment: Schema.optionalKey(Schema.Struct({ id: Schema.String, name: Schema.String })),
    features: Schema.optionalKey(Schema.Array(Schema.String)),
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

/** A pairing reaches one desktop on any of `hosts`, tried in order. */
export interface PairingTarget {
  readonly hosts: NonEmptyReadonlyArray<string>
  readonly port: number
  readonly token: string
}

/** The text the pairing QR code carries, as `hinacode://connect?host=a&host=b&port=&token=`. */
export const pairingUrl = ({ hosts, port, token }: PairingTarget) => {
  const url = new URL("hinacode://connect")
  for (const host of hosts) url.searchParams.append("host", host)
  url.searchParams.set("port", String(port))
  url.searchParams.set("token", token)
  return url.toString()
}

export const remoteWebSocketUrl = ({ host, port }: { readonly host: string; readonly port: number }) =>
  `ws://${host.includes(":") ? `[${host}]` : host}:${port}${REMOTE_PATH}`

const isAuthorityOnlyHost = (host: string) =>
  host !== "" && !/[\s/?#@[\]\\]/.test(host) && URL.parse(remoteWebSocketUrl({ host, port: 1 })) !== null

/**
 * Reads a pairing URL back, keeping the order of repeated `host`s. Null for anything that is not a
 * complete `hinacode://connect` URL.
 */
export const parsePairingUrl = (text: string): PairingTarget | null => {
  const url = URL.parse(text.trim())
  if (!url || url.protocol !== "hinacode:" || url.host !== "connect") return null
  const hosts = url.searchParams.getAll("host")
  const port = Number(url.searchParams.get("port"))
  const token = url.searchParams.get("token")
  if (!isArrayNonEmpty(hosts) || !hosts.every(isAuthorityOnlyHost)) return null
  if (!token || !Number.isInteger(port) || port < 1 || port > 65535) return null
  return { hosts, port, token }
}
