import { Effect, Schema } from "effect"
import { BindHost } from "../shared/domain.ts"
import { RemoteAccess } from "./remote/access.ts"
import { Relay } from "./remote/relay.ts"
import { EXPIRED, type RelayError, type RelayLink } from "./remote/relayService.ts"
import type { PersistenceError } from "./services/errors.ts"
import { Settings } from "./services/Settings.ts"

export interface ServeConfig {
  readonly bindHost?: string
  readonly port?: number
  readonly rotateToken: boolean
  readonly relay?: "on" | "off"
}

const envFlag = (env: NodeJS.ProcessEnv, name: string): boolean => {
  const value = env[name]
  if (value === undefined || value === "0" || value === "false") return false
  if (value === "1" || value === "true") return true
  throw new Error(`${name} must be 1 or 0`)
}

const portOf = (raw: string, source: string): number => {
  const port = Number(raw)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`serve port from ${source} must be an integer between 1 and 65535`)
  }
  return port
}

export const restartCommand = (process: {
  readonly execPath: string
  readonly execArgv: ReadonlyArray<string>
  readonly argv: ReadonlyArray<string>
  readonly env: NodeJS.ProcessEnv
}) => {
  const { HINACODE_SERVE_ROTATE_TOKEN: _rotated, ...env } = process.env
  return {
    file: process.execPath,
    args: [process.execPath, ...process.execArgv, ...process.argv.slice(1).filter((arg) => arg !== "--rotate-token")],
    env,
  }
}

export const autoUpdate = (env: NodeJS.ProcessEnv): boolean =>
  env["HINACODE_SERVE_AUTO_UPDATE"] === undefined || envFlag(env, "HINACODE_SERVE_AUTO_UPDATE")

export interface ServeFlags {
  readonly port?: number | undefined
  readonly host?: string | undefined
  readonly relay?: "on" | "off" | undefined
  readonly rotateToken: boolean
}

const relayFromEnv = (env: NodeJS.ProcessEnv) => {
  const relay = env["HINACODE_SERVE_RELAY"]
  if (relay === undefined || relay === "on" || relay === "off") return relay
  throw new Error("HINACODE_SERVE_RELAY must be on or off")
}

export const serveConfig = (flags: ServeFlags, env: NodeJS.ProcessEnv): ServeConfig => {
  const envPort = env["HINACODE_SERVE_PORT"]
  const port =
    flags.port !== undefined
      ? portOf(String(flags.port), "--port")
      : envPort !== undefined
        ? portOf(envPort, "HINACODE_SERVE_PORT")
        : undefined
  const bindHost = flags.host ?? env["HINACODE_SERVE_HOST"]
  if (bindHost !== undefined && bindHost.trim() === "") throw new Error("serve host must not be empty")
  if (bindHost !== undefined && !Schema.is(BindHost)(bindHost)) {
    throw new Error(
      `--host ${bindHost} would listen on every network this machine joins. Pass one address, or private.`,
    )
  }
  const relay = flags.relay ?? relayFromEnv(env)

  return {
    ...(bindHost !== undefined && { bindHost }),
    ...(port !== undefined && { port }),
    ...(relay !== undefined && { relay }),
    rotateToken: flags.rotateToken || envFlag(env, "HINACODE_SERVE_ROTATE_TOKEN"),
  }
}

export const applyServeConfig = (config: ServeConfig): Effect.Effect<void, PersistenceError, Settings | RemoteAccess> =>
  Effect.gen(function* () {
    const settings = yield* Settings
    const current = (yield* settings.get).remote
    const bindHost = config.bindHost ?? current.bindHost
    const next = { enabled: true as const, bindHost, port: config.port ?? current.port }
    if (next.enabled !== current.enabled || next.bindHost !== current.bindHost || next.port !== current.port) {
      yield* settings.set({ remote: next })
    }
    if (config.rotateToken) yield* RemoteAccess.use((remote) => remote.rotateToken)
  })

export const applyServeRelay = (
  relay: ServeConfig["relay"],
  onLink: (link: RelayLink) => Effect.Effect<void>,
): Effect.Effect<void, RelayError | PersistenceError, Relay> =>
  Effect.gen(function* () {
    if (relay === undefined) return
    const service = yield* Relay
    if (relay === "off") return yield* service.remove
    if ("hostname" in (yield* service.status)) return
    yield* service.setup({ onLink }).pipe(Effect.retry({ while: (error) => error.message === EXPIRED }))
  })

export const browserCommand = (
  url: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): { readonly file: string; readonly args: ReadonlyArray<string> } | null => {
  const parsed = URL.parse(url)
  if (parsed === null || (parsed.protocol !== "https:" && parsed.protocol !== "http:")) return null
  if (env["SSH_CONNECTION"] !== undefined || env["SSH_TTY"] !== undefined) return null
  if (platform === "darwin") return { file: "open", args: [parsed.href] }
  if (platform === "win32") return { file: "rundll32", args: ["url.dll,FileProtocolHandler", parsed.href] }
  return env["DISPLAY"] || env["WAYLAND_DISPLAY"] ? { file: "xdg-open", args: [parsed.href] } : null
}

export const linkInstructions = (url: string) =>
  [
    "Link this machine to your HinaCode account.",
    "Open this URL in any browser, on this machine or another:",
    "",
    `  ${url}`,
    "",
    "Waiting for you to approve it…",
    "",
  ].join("\n")
