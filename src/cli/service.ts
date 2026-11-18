import { execFile } from "node:child_process"
import { accessSync, constants, readFileSync } from "node:fs"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { homedir, userInfo } from "node:os"
import { dirname, join, resolve, sep } from "node:path"
import { isSea } from "node:sea"
import { setTimeout as sleep } from "node:timers/promises"
import { promisify } from "node:util"
import { Effect } from "effect"
import { Command } from "effect/cli"
import { isAlive } from "../main/dataDir.ts"
import { CliFailure, EXIT, usageError } from "./exit.ts"
import { cloudData } from "./serve.ts"

export const SERVICE_LABEL = "ai.hinacode.serve"
const SYSTEMD_UNIT = "hinacode.service"
const STOP_WAIT_MS = 8000

export interface ServiceSpec {
  readonly command: ReadonlyArray<string>
  readonly env: Readonly<Record<string, string>>
  readonly home: string
}

const xml = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;")
const xmlString = (text: string) => `<string>${xml(text)}</string>`

export const launchdPlist = ({ command, env, home }: ServiceSpec, log: string) =>
  [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">`,
    `<plist version="1.0">`,
    `<dict>`,
    `  <key>Label</key>`,
    `  ${xmlString(SERVICE_LABEL)}`,
    `  <key>ProgramArguments</key>`,
    `  <array>`,
    ...command.map((word) => `    ${xmlString(word)}`),
    `  </array>`,
    `  <key>EnvironmentVariables</key>`,
    `  <dict>`,
    ...Object.entries({ ...env, HINACODE_SERVE_LOG: log }).flatMap(([name, value]) => [
      `    <key>${xml(name)}</key>`,
      `    ${xmlString(value)}`,
    ]),
    `  </dict>`,
    `  <key>WorkingDirectory</key>`,
    `  ${xmlString(home)}`,
    `  <key>RunAtLoad</key>`,
    `  <true/>`,
    `  <key>KeepAlive</key>`,
    `  <true/>`,
    `  <key>StandardOutPath</key>`,
    `  ${xmlString(log)}`,
    `  <key>StandardErrorPath</key>`,
    `  ${xmlString(log)}`,
    `</dict>`,
    `</plist>`,
    ``,
  ].join("\n")

const systemdQuoted = (text: string) =>
  `"${text.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%")}"`

export const systemdUnit = ({ command, env }: ServiceSpec) =>
  [
    `[Unit]`,
    `Description=HinaCode cloud`,
    ``,
    `[Service]`,
    `ExecStart=${command.map((word) => systemdQuoted(word).replaceAll("$", () => "$$")).join(" ")}`,
    ...Object.entries(env).map(([name, value]) => `Environment=${systemdQuoted(`${name}=${value}`)}`),
    `Restart=on-failure`,
    ``,
    `[Install]`,
    `WantedBy=default.target`,
    ``,
  ].join("\n")

const isExecutable = (path: string) => {
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

export const serveCommand = (running: {
  readonly sea: boolean
  readonly execPath: string
  readonly script: string | undefined
  readonly executable: (path: string) => boolean
}): Effect.Effect<ReadonlyArray<string>, CliFailure> => {
  const program = running.sea ? running.execPath : running.script
  const install =
    "Install it with npm install -g --allow-scripts=node-pty hinacode, or use the executable from a release."
  if (program === undefined || program.split(sep).includes("_npx")) {
    return Effect.fail(usageError(`the service needs a hinacode that stays where it is. ${install}`))
  }
  if (!running.executable(program)) return Effect.fail(usageError(`${program} cannot run on its own. ${install}`))
  return Effect.succeed([program, "serve"])
}

const execFileAsync = promisify(execFile)
const exec = (file: string, args: ReadonlyArray<string>) =>
  execFileAsync(file, [...args]).then(
    ({ stdout }) => stdout.trim(),
    (error: NodeJS.ErrnoException & { stderr?: string }) => {
      throw new Error(error.stderr?.trim() || error.message, { cause: error })
    },
  )
const quietly = (file: string, args: ReadonlyArray<string>) => exec(file, args).catch(() => "")

const servePid = (userData: string) => {
  try {
    const pid = Number(readFileSync(join(userData, "daemon.pid"), "utf8"))
    return Number.isInteger(pid) && pid > 0 && isAlive(pid) ? pid : undefined
  } catch {
    return undefined
  }
}

const waitUntilFree = async (userData: string) => {
  for (let waited = 0; waited < STOP_WAIT_MS; waited += 200) {
    if (servePid(userData) === undefined) return
    await sleep(200)
  }
  const pid = servePid(userData)
  if (pid !== undefined) {
    throw new Error(`another hinacode serve (pid ${pid}) uses ${userData}. Stop it, then install the service again.`)
  }
}

const launchd = (home: string) => ({
  plist: join(home, "Library", "LaunchAgents", `${SERVICE_LABEL}.plist`),
  log: join(home, "Library", "Logs", "hinacode", "serve.log"),
  domain: `gui/${process.getuid?.() ?? 0}`,
})

const systemdUnitPath = (home: string) =>
  join(process.env["XDG_CONFIG_HOME"] || join(home, ".config"), "systemd", "user", SYSTEMD_UNIT)

const lingerHint = async () => {
  const { username } = userInfo()
  const linger = await quietly("loginctl", ["show-user", username, "--property=Linger", "--value"])
  return linger === "no" ? [`Run loginctl enable-linger ${username} to start it at boot without logging in.`] : []
}

const install = async (spec: ServiceSpec, userData: string): Promise<ReadonlyArray<string>> => {
  if (process.platform === "darwin") {
    const { plist, log, domain } = launchd(spec.home)
    await quietly("launchctl", ["bootout", `${domain}/${SERVICE_LABEL}`])
    await waitUntilFree(userData)
    await mkdir(dirname(plist), { recursive: true })
    await mkdir(dirname(log), { recursive: true })
    await writeFile(plist, launchdPlist(spec, log))
    await exec("launchctl", ["bootstrap", domain, plist])
    return [`Started ${SERVICE_LABEL} from ${plist}.`, `Log: ${log}`]
  }
  const unit = systemdUnitPath(spec.home)
  await quietly("systemctl", ["--user", "stop", SYSTEMD_UNIT])
  await waitUntilFree(userData)
  await mkdir(dirname(unit), { recursive: true })
  await writeFile(unit, systemdUnit(spec))
  await exec("systemctl", ["--user", "daemon-reload"])
  await exec("systemctl", ["--user", "enable", "--now", SYSTEMD_UNIT])
  return [`Started ${SYSTEMD_UNIT} from ${unit}.`, `Log: journalctl --user -u hinacode -f`, ...(await lingerHint())]
}

const uninstall = async (home: string): Promise<ReadonlyArray<string>> => {
  if (process.platform === "darwin") {
    const { plist, domain } = launchd(home)
    await quietly("launchctl", ["bootout", `${domain}/${SERVICE_LABEL}`])
    await rm(plist, { force: true })
    return [`Removed ${plist}.`]
  }
  const unit = systemdUnitPath(home)
  await quietly("systemctl", ["--user", "disable", "--now", SYSTEMD_UNIT])
  await rm(unit, { force: true })
  await exec("systemctl", ["--user", "daemon-reload"])
  return [`Removed ${unit}.`]
}

const supported = Effect.suspend(() =>
  process.platform === "darwin" || process.platform === "linux"
    ? Effect.void
    : Effect.fail(usageError("hinacode service runs on macOS and Linux")),
)

const report = (command: string, work: () => Promise<ReadonlyArray<string>>) =>
  supported.pipe(
    Effect.andThen(
      Effect.tryPromise({
        try: work,
        catch: (error) =>
          new CliFailure({
            code: EXIT.failed,
            message: `service ${command}: ${error instanceof Error ? error.message : String(error)}`,
          }),
      }),
    ),
    Effect.flatMap((lines) => Effect.sync(() => process.stdout.write(`${lines.join("\n")}\n`))),
  )

const installCommand = Command.make("install", {}, () =>
  Effect.gen(function* () {
    const userData = resolve(yield* cloudData)
    const command = yield* serveCommand({
      sea: isSea(),
      execPath: process.execPath,
      script: process.argv[1],
      executable: isExecutable,
    })
    const env = { PATH: process.env["PATH"] || "/usr/bin:/bin", HINACODE_USER_DATA: userData }
    yield* report("install", () => install({ command, env, home: homedir() }, userData))
  }),
).pipe(
  Command.withDescription(
    "Run hinacode serve as a user service that starts at login and restarts when it stops: launchd on macOS, systemd on Linux. Run it again to rewrite the service.",
  ),
)

const uninstallCommand = Command.make("uninstall", {}, () => report("uninstall", () => uninstall(homedir()))).pipe(
  Command.withDescription("Stop the service and remove it. The data directory stays."),
)

export const service = Command.make("service").pipe(
  Command.withDescription("Install or remove hinacode serve as a service on this machine."),
  Command.withSubcommands([installCommand, uninstallCommand]),
)
