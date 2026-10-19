import { mkdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { homedir, hostname } from "node:os"
import { join } from "node:path"
import { Effect, Layer, ManagedRuntime } from "effect"
import { pairingUrl } from "../shared/remote.ts"
import { makeAppLayer } from "./app.ts"
import { RemoteAccess } from "./remote/access.ts"
import { serveConfig } from "./serve.ts"
import { noKeyring } from "./services/Secrets.ts"
import { unsupported, Updates } from "./services/Updates.ts"
import { hydratePath } from "./shellPath.ts"

const USAGE = `Usage: hinacode serve [--port <n>] [--host <host>] [--rotate-token]

Runs a HinaCode cloud: agents, worktrees and threads on this machine, driven from the
desktop or phone app. Data lives in HINACODE_USER_DATA, default ~/.hinacode-cloud.`

const QUIT_TIMEOUT_MS = 5000
const LISTEN_TIMEOUT_MS = 5000

// Bundled to out/main/daemon.js, and run from source in tests; package.json is two levels up from both.
const { version } = createRequire(import.meta.url)("../../package.json") as { version: string }

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
      if (isAlive(pid)) throw new Error(`another hinacode serve (pid ${pid}) uses ${dir}`, { cause: error })
      rmSync(path, { force: true })
    }
  }
  process.on("exit", () => rmSync(path, { force: true }))
}

/** Waits until the listener is bound, then prints the pairing URLs. Stdout is how systemd or launchd keeps them. */
const printPairing = async (runtime: ManagedRuntime.ManagedRuntime<RemoteAccess, unknown>, userData: string) => {
  const deadline = Date.now() + LISTEN_TIMEOUT_MS
  for (;;) {
    const status = await runtime.runPromise(RemoteAccess.use((remote) => remote.status))
    if (status.listening) break
    if (status.listenError) throw new Error(`remote listener failed: ${status.listenError}`)
    if (Date.now() > deadline) throw new Error("remote listener did not start in time")
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  const pairing = await runtime.runPromise(RemoteAccess.use((remote) => remote.pairing))
  const lines = [
    `HinaCode cloud ${version}`,
    `data: ${userData}`,
    "pair a phone with:",
    `  ${pairingUrl(pairing)}`,
    "pair a desktop with one of:",
    ...pairing.hosts.map((host) => `  ${pairingUrl({ ...pairing, hosts: [host] })}`),
  ]
  process.stdout.write(`${lines.join("\n")}\n`)
}

const main = async (argv: ReadonlyArray<string>) => {
  const [command] = argv
  if (command === "--version") return void process.stdout.write(`${version}\n`)
  if (command !== "serve") {
    process.stderr.write(`${USAGE}\n`)
    return void (process.exitCode = command === "--help" || command === "-h" ? 0 : 1)
  }
  const serve = serveConfig(argv, process.env)
  const userData = process.env["HINACODE_USER_DATA"] || join(homedir(), ".hinacode-cloud")
  mkdirSync(userData, { recursive: true, mode: 0o700 })
  lockDataDir(userData)
  await hydratePath(process.env)

  const runtime = ManagedRuntime.make(
    makeAppLayer({
      userData,
      sbxConfigPath: join(appData(), "sbx", "config.json"),
      keyring: noKeyring,
      updates: Layer.succeed(Updates, unsupported(version)),
      toWindows: () => {},
      serve,
    }),
  )
  let stopping = false
  const stop = () => {
    if (stopping) return
    stopping = true
    // Running turns persist their messages and status, but a stuck one must not hold the service manager forever.
    const disposal = runtime.dispose().catch((cause: unknown) => console.error("runtime dispose failed", cause))
    const timeout = new Promise((resolve) => setTimeout(resolve, QUIT_TIMEOUT_MS))
    void Promise.race([disposal, timeout]).then(() => process.exit(0))
  }
  process.on("SIGINT", stop)
  process.on("SIGTERM", stop)
  // Build the layer (open the database, run migrations, bind the listener) before printing anything.
  await runtime.runPromise(Effect.void)
  await printPairing(runtime, userData)
}

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(`hinacode serve: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
