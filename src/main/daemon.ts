import { existsSync, mkdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { homedir, hostname } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { Effect, Layer, ManagedRuntime, References } from "effect"
import QRCode from "qrcode"
import type { RemotePairing } from "../shared/domain.ts"
import { isPortInUse, pairingUrl } from "../shared/remote.ts"
import { makeAppLayer } from "./app.ts"
import * as CloudUpdater from "./cloudUpdater.ts"
import * as Db from "./db/client.ts"
import { layer as RemoteAccessLayer, RemoteAccess } from "./remote/access.ts"
import { autoUpdate, parseCommand, serveConfig, USAGE, UsageError } from "./serve.ts"
import { layer as SecretsLayer, noKeyring } from "./services/Secrets.ts"
import { layer as SettingsLayer, Settings } from "./services/Settings.ts"
import { hydratePath } from "./shellPath.ts"

const QUIT_TIMEOUT_MS = 5000
const LISTEN_TIMEOUT_MS = 5000

// Bundled to out/main/daemon.js, and run from source in tests; package.json is two levels up from both.
const { version } = createRequire(import.meta.url)("../../package.json") as { version: string }
const packageRoot = fileURLToPath(new URL("../..", import.meta.url))

/** Electron's `appData`, where `sbx login` keeps its config. */
const appData = () =>
  process.platform === "darwin"
    ? join(homedir(), "Library", "Application Support")
    : process.platform === "win32"
      ? (process.env["APPDATA"] ?? join(homedir(), "AppData", "Roaming"))
      : (process.env["XDG_CONFIG_HOME"] ?? join(homedir(), ".config"))

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

/**
 * One process per data directory: a second would run the same pollers and agents on one database. The desktop
 * app holds Chromium's `SingletonLock`, a symlink to `<host>-<pid>`; a daemon holds `daemon.pid`.
 */
const lockDataDir = (dir: string) => {
  const desktop = (() => {
    try {
      return readlinkSync(join(dir, "SingletonLock"))
    } catch {
      return undefined
    }
  })()
  const desktopPid = desktop?.startsWith(`${hostname()}-`) ? Number(desktop.slice(hostname().length + 1)) : NaN
  if (isAlive(desktopPid)) throw new Error(`the HinaCode app (pid ${desktopPid}) uses ${dir}`)

  const path = join(dir, "daemon.pid")
  for (;;) {
    try {
      writeFileSync(path, String(process.pid), { flag: "wx" })
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      const pid = Number(readFileSync(path, "utf8"))
      // After an update, `process.execve` boots the new release under the same pid, holding the lock already.
      if (pid === process.pid) break
      if (isAlive(pid)) throw new Error(`another hinacode serve (pid ${pid}) uses ${dir}`, { cause: error })
      rmSync(path, { force: true })
    }
  }
  process.on("exit", () => rmSync(path, { force: true }))
}

/** The pairing block `hinacode serve` and `hinacode pair` print. Stdout is how systemd or launchd keeps it. */
const pairingText = async (userData: string, pairing: RemotePairing) => {
  const phoneUrl = pairingUrl(pairing)
  const qr = await QRCode.toString(phoneUrl, { type: "terminal", small: true })
  return [
    `HinaCode cloud ${version}`,
    `data: ${userData}`,
    "",
    "Pair a phone: scan this code in the HinaCode app, or paste the URL.",
    `  ${phoneUrl}`,
    qr,
    "Pair a desktop: Settings > Environments > Add environment, with one of:",
    ...pairing.hosts.map((host) => `  ${pairingUrl({ ...pairing, hosts: [host] })}`),
    "Keep the token in these URLs private. Run `hinacode pair` to print them again.",
    "",
  ].join("\n")
}

/** Waits until the listener is bound, then returns what pairs a client with it. */
const listening = async (runtime: ManagedRuntime.ManagedRuntime<RemoteAccess | Settings, unknown>) => {
  const deadline = Date.now() + LISTEN_TIMEOUT_MS
  for (;;) {
    const status = await runtime.runPromise(RemoteAccess.use((remote) => remote.status))
    if (status.listening) break
    if (status.listenError !== null && isPortInUse(status.listenError)) {
      const { port } = (await runtime.runPromise(Settings.use((settings) => settings.get))).remote
      throw new Error(
        `port ${port} is in use, perhaps by the HinaCode desktop's Remote or another cloud. Pick another with --port <n>.`,
      )
    }
    if (status.listenError !== null) throw new Error(`remote listener failed: ${status.listenError}`)
    if (Date.now() > deadline) throw new Error("remote listener did not start in time")
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return runtime.runPromise(RemoteAccess.use((remote) => remote.pairing))
}

const serve = async (argv: ReadonlyArray<string>, userData: string) => {
  const config = serveConfig(argv, process.env)
  mkdirSync(userData, { recursive: true, mode: 0o700 })
  lockDataDir(userData)
  await hydratePath(process.env)

  const runtime = ManagedRuntime.make(
    makeAppLayer({
      userData,
      sbxConfigPath: join(appData(), "sbx", "config.json"),
      keyring: noKeyring,
      updates: CloudUpdater.layer({
        current: version,
        packageRoot,
        registry: process.env["npm_config_registry"] || "https://registry.npmjs.org",
        autoInstall: autoUpdate(process.env),
        restart: () =>
          stop(() =>
            process.execve!(process.execPath, [process.execPath, ...process.execArgv, ...process.argv.slice(1)]),
          ),
      }),
      toWindows: () => {},
      serve: config,
    }),
  )
  let stopping = false
  const stop = (then: () => void) => {
    if (stopping) return
    stopping = true
    // Running turns persist their messages and status, but a stuck one must not hold the service manager forever.
    const disposal = runtime.dispose().catch((cause: unknown) => console.error("runtime dispose failed", cause))
    const timeout = new Promise((resolve) => setTimeout(resolve, QUIT_TIMEOUT_MS))
    void Promise.race([disposal, timeout]).then(then)
  }
  const quit = () => stop(() => process.exit(0))
  process.on("SIGINT", quit)
  process.on("SIGTERM", quit)
  // Build the layer (open the database, run migrations, bind the listener) before printing anything.
  await runtime.runPromise(Effect.void)
  process.stdout.write(await pairingText(userData, await listening(runtime)))
}

/**
 * Prints the pairing block of the cloud in `userData` without starting it. It takes no lock, since a running
 * daemon holds one and SQLite lets this read beside it, and builds only the services that hold the token.
 */
const pair = async (userData: string) => {
  const database = join(userData, "hinacode.sqlite")
  const noCloud = () => {
    process.stderr.write(`No cloud in ${userData} yet. Start one with \`hinacode serve\`.\n`)
    process.exitCode = 1
  }
  if (!existsSync(database)) return noCloud()
  const runtime = ManagedRuntime.make(
    RemoteAccessLayer.pipe(
      Layer.provideMerge(Layer.mergeAll(SettingsLayer, SecretsLayer)),
      Layer.provide(Layer.mergeAll(Db.layer(database), noKeyring)),
      Layer.provide(Layer.succeed(References.MinimumLogLevel, "Warn")),
    ),
  )
  try {
    const { remote } = await runtime.runPromise(Settings.use((settings) => settings.get))
    if (!remote.enabled) return noCloud()
    const pairing = await runtime.runPromise(RemoteAccess.use((access) => access.pairing))
    process.stdout.write(await pairingText(userData, pairing))
  } finally {
    await runtime.dispose()
  }
}

const main = async (argv: ReadonlyArray<string>) => {
  const command = parseCommand(argv)
  if (command === "help") return void process.stdout.write(`${USAGE}\n`)
  if (command === "version") return void process.stdout.write(`${version}\n`)
  const userData = process.env["HINACODE_USER_DATA"] || join(homedir(), ".hinacode-cloud")
  return command === "serve" ? serve(argv, userData) : pair(userData)
}

main(process.argv.slice(2)).catch((error: unknown) => {
  if (error instanceof UsageError) {
    process.stderr.write(`hinacode: ${error.message}\n\n${USAGE}\n`)
  } else {
    console.error(`hinacode ${process.argv[2]}: ${error instanceof Error ? error.message : String(error)}`)
  }
  process.exit(1)
})
