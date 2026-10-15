import { Schema } from "effect"
import { PushEvent } from "./contract.ts"

/** Path the phone upgrades to a WebSocket on. */
export const REMOTE_PATH = "/remote"

/** Bumped when a frame changes shape, so an old phone app says "update" instead of failing oddly. */
export const REMOTE_PROTOCOL_VERSION = 1

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
  /** `environment` names the kkcode that answered, so a desktop pairing it twice keeps one entry. Older ones omit it. */
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

/** Query string the pairing QR code carries, as `kkcode://connect?host=&port=&token=`. */
export const pairingUrl = (host: string, port: number, token: string) => {
  const url = new URL("kkcode://connect")
  url.searchParams.set("host", host)
  url.searchParams.set("port", String(port))
  url.searchParams.set("token", token)
  return url.toString()
}

export interface PairingTarget {
  readonly host: string
  readonly port: number
  readonly token: string
}

/** Reads a pairing URL back. Null for anything that is not a complete `kkcode://connect` URL. */
export const parsePairingUrl = (text: string): PairingTarget | null => {
  const url = URL.parse(text.trim())
  if (!url || url.protocol !== "kkcode:") return null
  const host = url.searchParams.get("host")
  const port = Number(url.searchParams.get("port"))
  const token = url.searchParams.get("token")
  if (!host || !token || !Number.isInteger(port) || port < 1 || port > 65535) return null
  return { host, port, token }
}

export const remoteWebSocketUrl = ({ host, port }: Pick<PairingTarget, "host" | "port">) =>
  `ws://${host.includes(":") ? `[${host}]` : host}:${port}${REMOTE_PATH}`
