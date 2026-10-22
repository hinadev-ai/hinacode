import { Effect } from "effect"
import { RemoteAccess } from "./remote/access.ts"
import type { PersistenceError } from "./services/errors.ts"
import { Settings } from "./services/Settings.ts"

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

/** Whether a cloud installs new releases on its own once idle. On unless `HINACODE_SERVE_AUTO_UPDATE` is 0 or false. */
export const autoUpdate = (env: NodeJS.ProcessEnv): boolean =>
  env["HINACODE_SERVE_AUTO_UPDATE"] === undefined || envFlag(env, "HINACODE_SERVE_AUTO_UPDATE")

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
