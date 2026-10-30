import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { homedir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { Effect, Layer, ManagedRuntime, References } from "effect"
import QRCode from "qrcode"
import type { RemotePairing } from "../shared/domain.ts"
import { isPortInUse, pairingUrl } from "../shared/remote.ts"
import { makeAppLayer } from "./app.ts"
import * as CloudUpdater from "./cloudUpdater.ts"
import { chromiumDir, desktopPid, isAlive } from "./dataDir.ts"
import * as Db from "./db/client.ts"
import { layer as RemoteAccessLayer, RemoteAccess } from "./remote/access.ts"
import { storedTunnel } from "./remote/relay.ts"
import type { RelayLink } from "./remote/relayService.ts"
import { applyServeRelay, autoUpdate, parseCommand, restartCommand, serveConfig, USAGE, UsageError } from "./serve.ts"
import { layer as SecretsLayer, noKeyring } from "./services/Secrets.ts"
import { layer as SettingsLayer, Settings } from "./services/Settings.ts"
import { hydratePath } from "./shellPath.ts"

const QUIT_TIMEOUT_MS = 5000
const LISTEN_TIMEOUT_MS = 5000

const { version } = createRequire(import.meta.url)("../../package.json") as { version: string }
const packageRoot = fileURLToPath(new URL("../..", import.meta.url))

const appData = () =>
  process.platform === "darwin"
    ? join(homedir(), "Library", "Application Support")
    : process.platform === "win32"
      ? (process.env["APPDATA"] ?? join(homedir(), "AppData", "Roaming"))
      : (process.env["XDG_CONFIG_HOME"] ?? join(homedir(), ".config"))

const lockDataDir = (dir: string) => {
  const desktop = desktopPid(chromiumDir(dir))
  if (desktop !== undefined) throw new Error(`the HinaCode app (pid ${desktop}) uses ${dir}`)

  const path = join(dir, "daemon.pid")
  for (;;) {
    try {
      writeFileSync(path, String(process.pid), { flag: "wx" })
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      const pid = Number(readFileSync(path, "utf8"))
      // FIXME: `process.execve` keeps the pid, so an updated release already holds the lock
      if (pid === process.pid) break
      if (isAlive(pid)) throw new Error(`another hinacode serve (pid ${pid}) uses ${dir}`, { cause: error })
      rmSync(path, { force: true })
    }
  }
  process.on("exit", () => rmSync(path, { force: true }))
}

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
    ...(pairing.relay === null ? [] : [`Reachable from any network through ${pairing.relay}.`, ""]),
    "Pair a desktop: Settings > Environments > Add environment, with one of:",
    ...pairing.hosts.map((host) => `  ${pairingUrl({ ...pairing, hosts: [host] })}`),
    "Keep the token in these URLs private. Run `hinacode pair` to print them again.",
    "",
  ].join("\n")
}

const printLink = ({ url, userCode }: RelayLink) =>
  Effect.sync(() =>
    process.stdout.write(`Open ${url} to link this cloud to your HinaCode account. The code is ${userCode}.\n`),
  )

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
          stop(() => {
            const { file, args, env } = restartCommand(process)
            process.execve!(file, args, env)
          }),
      }),
      toWindows: () => {},
      serve: config,
    }),
  )
  let stopping = false
  const stop = (then: () => void) => {
    if (stopping) return
    stopping = true
    const disposal = runtime.dispose().catch((cause: unknown) => console.error("runtime dispose failed", cause))
    const timeout = new Promise((resolve) => setTimeout(resolve, QUIT_TIMEOUT_MS))
    void Promise.race([disposal, timeout]).then(then)
  }
  const quit = () => stop(() => process.exit(0))
  process.on("SIGINT", quit)
  process.on("SIGTERM", quit)
  await runtime.runPromise(Effect.void)
  await listening(runtime)
  try {
    await runtime.runPromise(applyServeRelay(config.relay, printLink))
  } catch (error) {
    await runtime.dispose()
    throw error
  }
  const pairing = await runtime.runPromise(RemoteAccess.use((remote) => remote.pairing))
  process.stdout.write(await pairingText(userData, pairing))
}

const pair = async (userData: string) => {
  const database = join(userData, "hinacode.sqlite")
  const noCloud = () => {
    process.stderr.write(`No cloud in ${userData} yet. Start one with \`hinacode serve\`.\n`)
    process.exitCode = 1
  }
  if (!existsSync(database)) return noCloud()
  const runtime = ManagedRuntime.make(
    RemoteAccessLayer.pipe(
      Layer.provideMerge(Layer.mergeAll(SettingsLayer(userData), SecretsLayer)),
      Layer.provideMerge(Layer.mergeAll(Db.layer(database), noKeyring)),
      Layer.provide(Layer.succeed(References.MinimumLogLevel, "Warn")),
    ),
  )
  try {
    const { remote } = await runtime.runPromise(Settings.use((settings) => settings.get))
    if (!remote.enabled) return noCloud()
    const pairing = await runtime.runPromise(RemoteAccess.use((access) => access.pairing))
    const tunnel = await runtime.runPromise(storedTunnel)
    process.stdout.write(await pairingText(userData, { ...pairing, relay: tunnel?.hostname ?? null }))
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
