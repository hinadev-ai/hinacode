import { execFileSync } from "node:child_process"
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join, sep } from "node:path"
import { isAlive } from "../main/dataDir.ts"

export const INSTALL_COMMAND = "curl -fsSL https://hinacode.app/install.sh | bash"

const SERVICE_START_TIMEOUT_MS = 30_000

export interface CloudService {
  readonly program: ReadonlyArray<string>
  readonly env: Readonly<Record<string, string>>
  readonly log: string
}

interface Step {
  readonly file: string
  readonly args: ReadonlyArray<string>
  readonly onFailure?: "ignore" | { readonly warn: string }
}

export interface ServiceManager {
  readonly kind: string
  readonly unitPath: string
  readonly log: string
  readonly render: (service: CloudService) => string
  readonly stop: ReadonlyArray<Step>
  readonly reload: ReadonlyArray<Step>
  readonly start: ReadonlyArray<Step>
  readonly disable: ReadonlyArray<Step>
}

export interface ServiceHost {
  readonly platform: NodeJS.Platform
  readonly home: string
  readonly uid: number
  readonly env: NodeJS.ProcessEnv
}

const systemctl = (...args: ReadonlyArray<string>): Step["args"] => ["--user", ...args]

const LAUNCHD_LABEL = "ai.hinacode.serve"
const SYSTEMD_UNIT = "hinacode.service"

const xmlEscape = (value: string) => value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`)

const plistString = (value: string) => `<string>${xmlEscape(value)}</string>`

export const launchAgentPlist = ({ program, env, log }: CloudService) =>
  [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    `  <key>Label</key>${plistString(LAUNCHD_LABEL)}`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    ...program.map((arg) => `    ${plistString(arg)}`),
    "  </array>",
    "  <key>EnvironmentVariables</key>",
    "  <dict>",
    ...Object.entries(env).map(([name, value]) => `    <key>${xmlEscape(name)}</key>${plistString(value)}`),
    "  </dict>",
    "  <key>RunAtLoad</key><true/>",
    "  <key>KeepAlive</key><true/>",
    `  <key>StandardOutPath</key>${plistString(log)}`,
    `  <key>StandardErrorPath</key>${plistString(log)}`,
    "</dict>",
    "</plist>",
    "",
  ].join("\n")

const systemdQuote = (value: string) => `"${value.replace(/[\\"]/g, (char) => `\\${char}`).replace(/%/g, "%%")}"`

const systemdArg = (value: string) => systemdQuote(value).replace(/\$/g, () => "$$")

export const systemdUnit = ({ program, env, log }: CloudService) =>
  [
    "[Unit]",
    "Description=HinaCode cloud",
    "",
    "[Service]",
    `ExecStart=${program.map(systemdArg).join(" ")}`,
    ...Object.entries(env).map(([name, value]) => `Environment=${systemdQuote(`${name}=${value}`)}`),
    "Restart=always",
    "RestartSec=5",
    `StandardOutput=append:${log.replace(/%/g, "%%")}`,
    `StandardError=append:${log.replace(/%/g, "%%")}`,
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n")

export const serviceManager = ({ platform, home, uid, env }: ServiceHost): ServiceManager => {
  if (platform === "darwin") {
    const unitPath = join(home, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`)
    const bootout: Step = { file: "launchctl", args: ["bootout", `gui/${uid}/${LAUNCHD_LABEL}`], onFailure: "ignore" }
    return {
      kind: "launchd agent",
      unitPath,
      log: join(home, "Library", "Logs", "hinacode", "serve.log"),
      render: launchAgentPlist,
      stop: [bootout],
      reload: [],
      start: [{ file: "launchctl", args: ["bootstrap", `gui/${uid}`, unitPath] }],
      disable: [bootout],
    }
  }
  if (platform === "linux") {
    const configHome = env["XDG_CONFIG_HOME"] || join(home, ".config")
    const stateHome = env["XDG_STATE_HOME"] || join(home, ".local", "state")
    return {
      kind: "systemd user service",
      unitPath: join(configHome, "systemd", "user", SYSTEMD_UNIT),
      log: join(stateHome, "hinacode", "serve.log"),
      render: systemdUnit,
      stop: [{ file: "systemctl", args: systemctl("stop", SYSTEMD_UNIT), onFailure: "ignore" }],
      reload: [{ file: "systemctl", args: systemctl("daemon-reload") }],
      start: [
        { file: "systemctl", args: systemctl("enable", "--now", SYSTEMD_UNIT) },
        {
          file: "loginctl",
          args: ["--no-ask-password", "enable-linger"],
          onFailure: {
            warn: "It starts when you log in. Run `sudo loginctl enable-linger $USER` to start it at boot instead.",
          },
        },
      ],
      disable: [{ file: "systemctl", args: systemctl("disable", "--now", SYSTEMD_UNIT), onFailure: "ignore" }],
    }
  }
  throw new Error(
    `connect runs the cloud as a service on macOS and Linux, not ${platform}. Run hinacode serve instead.`,
  )
}

export const serveProgram = (
  process: { readonly execPath: string; readonly argv: ReadonlyArray<string> },
  sea: boolean,
): ReadonlyArray<string> => {
  if (sea) return [process.execPath, "serve"]
  const script = process.argv[1]
  if (script === undefined) throw new Error("cannot tell which script runs hinacode")
  if (script.split(sep).includes("_npx")) {
    throw new Error(
      `npx runs hinacode from a cache that npm may clear, so a service cannot point at it. Install it with \`${INSTALL_COMMAND}\`, or \`npm install -g --allow-scripts=node-pty hinacode\` and then \`hinacode connect\`.`,
    )
  }
  return [process.execPath, script, "serve"]
}

const runSteps = (steps: ReadonlyArray<Step>) => {
  for (const step of steps) {
    try {
      execFileSync(step.file, [...step.args], { stdio: ["ignore", "ignore", "pipe"] })
    } catch (error) {
      if (step.onFailure === "ignore") continue
      if (step.onFailure !== undefined) {
        process.stdout.write(`${step.onFailure.warn}\n`)
        continue
      }
      const stderr = String((error as { stderr?: Buffer }).stderr ?? "").trim()
      throw new Error(`${step.file} ${step.args.join(" ")} failed${stderr === "" ? "" : `: ${stderr}`}`, {
        cause: error,
      })
    }
  }
}

const daemonPid = (userData: string) => {
  try {
    const pid = Number(readFileSync(join(userData, "daemon.pid"), "utf8"))
    return Number.isInteger(pid) && isAlive(pid) ? pid : undefined
  } catch {
    return undefined
  }
}

const logTail = (log: string) => {
  try {
    return readFileSync(log, "utf8").trimEnd().split("\n").slice(-10).join("\n")
  } catch {
    return ""
  }
}

const waitForPairing = async (
  userData: string,
  log: string,
  pairingText: (userData: string) => Promise<string | undefined>,
) => {
  const deadline = Date.now() + SERVICE_START_TIMEOUT_MS
  for (;;) {
    if (daemonPid(userData) !== undefined) {
      const text = await pairingText(userData).catch(() => undefined)
      if (text !== undefined) return text
    }
    if (Date.now() > deadline) {
      const tail = logTail(log)
      throw new Error(
        `the cloud did not start in ${SERVICE_START_TIMEOUT_MS / 1000} seconds. ${log} ends with:\n${tail}`,
      )
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
}

export const connect = async (options: {
  readonly host: ServiceHost
  readonly program: ReadonlyArray<string>
  readonly userData: string
  readonly customDataDir: boolean
  readonly pairingText: (userData: string) => Promise<string | undefined>
}) => {
  const manager = serviceManager(options.host)
  runSteps(manager.stop)
  const other = daemonPid(options.userData)
  if (other !== undefined) {
    throw new Error(
      `another hinacode serve (pid ${other}) uses ${options.userData}. Stop it, then run hinacode connect again.`,
    )
  }
  const env = {
    PATH: options.host.env["PATH"] ?? "/usr/bin:/bin",
    ...(options.customDataDir && { HINACODE_USER_DATA: options.userData }),
  }
  mkdirSync(dirname(manager.unitPath), { recursive: true })
  mkdirSync(dirname(manager.log), { recursive: true })
  writeFileSync(manager.unitPath, manager.render({ program: options.program, env, log: manager.log }))
  runSteps(manager.reload)
  runSteps(manager.start)
  const pairing = await waitForPairing(options.userData, manager.log, options.pairingText)
  process.stdout.write(
    [
      `The HinaCode cloud runs as a ${manager.kind}. It restarts if it stops, and starts again after a reboot.`,
      `Service: ${manager.unitPath}`,
      `Log: ${manager.log}`,
      "Remove it with `hinacode disconnect`.",
      "",
      pairing,
    ].join("\n"),
  )
}

export const disconnect = (host: ServiceHost) => {
  const manager = serviceManager(host)
  runSteps(manager.disable)
  rmSync(manager.unitPath, { force: true })
  runSteps(manager.reload)
  process.stdout.write(
    `Removed the ${manager.kind}. The cloud's data stays in place, and \`hinacode connect\` brings it back.\n`,
  )
}
