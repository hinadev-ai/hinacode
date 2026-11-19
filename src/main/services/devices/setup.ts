import { spawn } from "node:child_process"
import { access, constants } from "node:fs/promises"
import type { DeviceCheck, Requirement } from "../../../shared/device.ts"
import { findBinary } from "../../agents/binary.ts"
import { DeviceError } from "./platform.ts"

const SETUP_TIMEOUT_MS = 30 * 60 * 1000

const isExecutable = (path: string) =>
  access(path, constants.X_OK).then(
    () => true,
    () => false,
  )

export const runSetup = (
  command: string,
  args: ReadonlyArray<string>,
  options: { readonly input?: string; readonly env?: NodeJS.ProcessEnv } = {},
): Promise<string> =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      timeout: SETUP_TIMEOUT_MS,
      killSignal: "SIGKILL",
      env: options.env ?? process.env,
    })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk: Buffer) => (stdout = (stdout + chunk.toString()).slice(-1_000_000)))
    child.stderr.on("data", (chunk: Buffer) => (stderr = (stderr + chunk.toString()).slice(-4000)))
    child.stdin.on("error", () => {})
    child.stdin.end(options.input ?? "")
    child.on("error", (error) => reject(new DeviceError(`${command} failed: ${error.message}`)))
    child.on("close", (code) => {
      if (code === 0) return resolve(stdout)
      const reason = (stderr.trim() || stdout.trim()).split("\n").at(-1)?.trim() || `exited with code ${code}`
      reject(new DeviceError(`${[command, ...args].join(" ")}: ${reason}`))
    })
  })

const findBrew = async () => {
  for (const path of ["/opt/homebrew/bin/brew", "/usr/local/bin/brew"]) {
    if (await isExecutable(path)) return path
  }
  return findBinary("brew")
}

export const brewInstall = async (formula: string) => {
  const brew = await findBrew()
  if (!brew) {
    throw new DeviceError(
      `Installing this needs Homebrew, which this machine does not have. Install it from https://brew.sh, then run: brew install ${formula}`,
    )
  }
  await runSetup(brew, ["install", formula], { env: { ...process.env, HOMEBREW_NO_AUTO_UPDATE: "1" } })
}

export const check = (
  requirement: Requirement,
  needed: DeviceCheck["needed"],
  fix: DeviceCheck["fix"],
  state: DeviceCheck["state"] | boolean,
): DeviceCheck => ({
  requirement,
  needed,
  fix,
  state: state === true ? "ready" : state === false ? "missing" : state,
})

export const cannotSetUp = (requirement: Requirement) =>
  Promise.reject(new DeviceError(`HinaCode cannot set up ${requirement} on this machine.`))
