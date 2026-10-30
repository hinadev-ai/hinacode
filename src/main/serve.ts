import { Effect, Schema } from "effect"
import { BindHost } from "../shared/domain.ts"
import { tailscaleAddress } from "./network.ts"
import { RemoteAccess } from "./remote/access.ts"
import { Relay } from "./remote/relay.ts"
import type { RelayError, RelayLink } from "./remote/relayService.ts"
import type { PersistenceError } from "./services/errors.ts"
import { Settings } from "./services/Settings.ts"

export const USAGE = `Usage: hinacode <command> [options]

Commands:
  serve   Run a HinaCode cloud: agents, worktrees and threads on this machine, driven from the desktop or phone app.
  pair    Print the pairing URLs and QR code of the cloud again, without restarting it.

serve options:
  --port <n>        Port to listen on, or HINACODE_SERVE_PORT.
  --host <host>     Address to bind, or HINACODE_SERVE_HOST. Defaults to this machine's Tailscale address.
                    Use 127.0.0.1 to reach the cloud only through the relay.
  --rotate-token    Replace the token, which unpairs every client, or HINACODE_SERVE_ROTATE_TOKEN=1.
  --relay on|off    Reach the cloud from any network through the HinaCode relay, or HINACODE_SERVE_RELAY.
                    on links it to your HinaCode account once, and needs cloudflared on PATH. off unlinks it.

  -h, --help        Print this help.
  --version         Print the version.

A cloud installed with npm install -g installs new releases on its own once nothing is running.
Set HINACODE_SERVE_AUTO_UPDATE=0 to update it by hand instead.

Data lives in HINACODE_USER_DATA, default ~/.hinacode-cloud.`

export class UsageError extends Error {}

export type Command = "help" | "version" | "serve" | "pair"

const OPTIONS: Record<
  "serve" | "pair",
  { readonly values: ReadonlyArray<string>; readonly switches: ReadonlyArray<string> }
> = {
  serve: { values: ["--port", "--host", "--relay"], switches: ["--rotate-token"] },
  pair: { values: [], switches: [] },
}

export const parseCommand = (argv: ReadonlyArray<string>): Command => {
  if (argv.includes("--help") || argv.includes("-h")) return "help"
  const [command, ...rest] = argv
  if (command === "--version") return "version"
  if (command !== "serve" && command !== "pair") {
    throw new UsageError(command === undefined ? "missing command" : `unknown command ${command}`)
  }
  const { values, switches } = OPTIONS[command]
  for (let index = 0; index < rest.length; index++) {
    const arg = rest[index]!
    const name = arg.split("=")[0]!
    if (values.includes(name)) {
      if (name === arg) index++
    } else if (!switches.includes(arg)) {
      throw new UsageError(arg.startsWith("-") ? `unknown option ${name}` : `unexpected argument ${arg}`)
    }
  }
  return command
}

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

const flagValue = (argv: ReadonlyArray<string>, name: string): string | undefined => {
  const inline = argv.find((arg) => arg.startsWith(`--${name}=`))
  if (inline !== undefined) return inline.slice(name.length + 3)
  const index = argv.indexOf(`--${name}`)
  if (index === -1) return undefined
  const value = argv[index + 1]
  if (value === undefined) throw new Error(`--${name} needs a value`)
  return value
}

export const serveConfig = (argv: ReadonlyArray<string>, env: NodeJS.ProcessEnv): ServeConfig => {
  const portFlag = flagValue(argv, "port")
  const envPort = env["HINACODE_SERVE_PORT"]
  const port =
    portFlag !== undefined
      ? portOf(portFlag, "--port")
      : envPort !== undefined
        ? portOf(envPort, "HINACODE_SERVE_PORT")
        : undefined
  const bindHost = flagValue(argv, "host") ?? env["HINACODE_SERVE_HOST"]
  if (bindHost !== undefined && bindHost.trim() === "") throw new Error("serve host must not be empty")
  if (bindHost !== undefined && !Schema.is(BindHost)(bindHost)) {
    throw new UsageError(`--host ${bindHost} would listen on every network this machine joins. Pass one address.`)
  }
  const relayFlag = flagValue(argv, "relay")
  const relay = relayFlag ?? env["HINACODE_SERVE_RELAY"]
  if (relay !== undefined && relay !== "on" && relay !== "off") {
    throw new UsageError(`${relayFlag !== undefined ? "--relay" : "HINACODE_SERVE_RELAY"} must be on or off`)
  }

  return {
    ...(bindHost !== undefined && { bindHost }),
    ...(port !== undefined && { port }),
    ...(relay !== undefined && { relay }),
    rotateToken: argv.includes("--rotate-token") || envFlag(env, "HINACODE_SERVE_ROTATE_TOKEN"),
  }
}

export class ServeHostRequired extends Schema.TaggedError<ServeHostRequired>()("ServeHostRequired", {
  message: Schema.String,
}) {}

export const applyServeConfig = (
  config: ServeConfig,
  tailscale: () => string | null = tailscaleAddress,
): Effect.Effect<void, PersistenceError | ServeHostRequired, Settings | RemoteAccess> =>
  Effect.gen(function* () {
    const settings = yield* Settings
    const current = (yield* settings.get).remote
    const bindHost = config.bindHost ?? current.bindHost ?? tailscale()
    if (bindHost === null) {
      return yield* new ServeHostRequired({
        message:
          "this machine has no Tailscale address to listen on. Pass --host <address>, or --host 127.0.0.1 --relay on to reach it only through the relay.",
      })
    }
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
    yield* service.setup({ onLink })
  })
