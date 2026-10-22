import { Effect } from "effect"
import { RemoteAccess } from "./remote/access.ts"
import type { PersistenceError } from "./services/errors.ts"
import { Settings } from "./services/Settings.ts"

export const USAGE = `Usage: hinacode <command> [options]

Commands:
  serve   Run a HinaCode cloud: agents, worktrees and threads on this machine, driven from the desktop or phone app.
  pair    Print the pairing URLs and QR code of the cloud again, without restarting it.

serve options:
  --port <n>        Port to listen on, or HINACODE_SERVE_PORT.
  --host <host>     Address to bind, or HINACODE_SERVE_HOST. 0.0.0.0 for every interface.
  --rotate-token    Replace the token, which unpairs every client, or HINACODE_SERVE_ROTATE_TOKEN=1.

  -h, --help        Print this help.
  --version         Print the version.

Data lives in HINACODE_USER_DATA, default ~/.hinacode-cloud.`

/** A command line that does not parse. The CLI prints it with the usage and exits 1. */
export class UsageError extends Error {}

export type Command = "help" | "version" | "serve" | "pair"

const OPTIONS: Record<
  "serve" | "pair",
  { readonly values: ReadonlyArray<string>; readonly switches: ReadonlyArray<string> }
> = {
  serve: { values: ["--port", "--host"], switches: ["--rotate-token"] },
  pair: { values: [], switches: [] },
}

/** The command `argv` asks for. An unknown option throws, so a typo never starts a daemon on the wrong port. */
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

/**
 * How one `hinacode serve` boot differs from the stored settings. A field left out keeps the stored
 * value, so a plain restart converges on the same listener and the same token.
 */
export interface ServeConfig {
  readonly bindHost?: string
  readonly port?: number
  readonly rotateToken: boolean
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

/** The `--name value` and `--name=value` spellings, or undefined when the flag is absent. */
const flagValue = (argv: ReadonlyArray<string>, name: string): string | undefined => {
  const inline = argv.find((arg) => arg.startsWith(`--${name}=`))
  if (inline !== undefined) return inline.slice(name.length + 3)
  const index = argv.indexOf(`--${name}`)
  if (index === -1) return undefined
  const value = argv[index + 1]
  if (value === undefined) throw new Error(`--${name} needs a value`)
  return value
}

/**
 * The `hinacode serve` configuration from its flags and environment. Flags win over the environment, and an
 * invalid value throws, because a daemon that silently picked another port would strand every paired client.
 */
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

  return {
    ...(bindHost !== undefined && { bindHost }),
    ...(port !== undefined && { port }),
    rotateToken: argv.includes("--rotate-token") || envFlag(env, "HINACODE_SERVE_ROTATE_TOKEN"),
  }
}

/**
 * Writes this boot's listener address into `settings.remote` and rotates the token when asked. It
 * runs while the app layer is built, before the remote listener first reads its settings, so the
 * listener starts once on this address and no client can pair with a token about to be replaced.
 */
export const applyServeConfig = (config: ServeConfig): Effect.Effect<void, PersistenceError, Settings | RemoteAccess> =>
  Effect.gen(function* () {
    const settings = yield* Settings
    const current = (yield* settings.get).remote
    const next = {
      enabled: true,
      bindHost: config.bindHost ?? current.bindHost,
      port: config.port ?? current.port,
    }
    if (next.enabled !== current.enabled || next.bindHost !== current.bindHost || next.port !== current.port) {
      yield* settings.set({ remote: next })
    }
    if (config.rotateToken) yield* RemoteAccess.use((remote) => remote.rotateToken)
  })
