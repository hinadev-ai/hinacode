#!/usr/bin/env node
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const [platform, device, label, action] = process.argv.slice(2)
const usage =
  "device-power.ts android <serial> <label> start|stop | device-power.ts ios <udid> <label> [duration, default 10m]"
assert(device && label && /^[a-zA-Z0-9_-]+$/.test(label), usage)
const directory = join(dirname(fileURLToPath(import.meta.url)), "../../.context/battery/devices", label)
mkdirSync(directory, { recursive: true })

const read = (command: string, args: string[]) => execFileSync(command, args, { encoding: "utf8", timeout: 60_000 })
const revision = () => read("git", ["rev-parse", "HEAD"]).trim()
const app = "com.hinadev.hinacode"

if (platform === "android") {
  assert(action === "start" || action === "stop", usage)
  const adb = (...args: string[]) => read("adb", ["-s", device, ...args])
  const file = join(directory, `android-${action}.json`)
  assert(!existsSync(file), `${file} already exists; choose a new label`)
  if (action === "stop") assert(existsSync(join(directory, "android-start.json")), "capture start before stop")
  const snapshot = {
    at: new Date().toISOString(),
    harnessRevision: revision(),
    serial: device,
    model: adb("shell", "getprop", "ro.product.model").trim(),
    emulator: adb("shell", "getprop", "ro.kernel.qemu").trim() === "1",
    battery: adb("shell", "dumpsys", "battery"),
    batterystats: adb("shell", "dumpsys", "batterystats", app),
    power: adb("shell", "dumpsys", "power"),
  }
  writeFileSync(file, JSON.stringify(snapshot, null, 2))
  console.log(file)
  console.log("Compare the two snapshots. BatteryStats energy is an estimate; emulator energy is not physical power.")
} else if (platform === "ios") {
  const duration = action ?? "10m"
  assert(/^\d+(?:s|m|h)$/.test(duration), "duration must be seconds, minutes, or hours, such as 10m")
  const output = join(directory, "ios.trace")
  assert(!existsSync(output), `${output} already exists; choose a new label`)
  writeFileSync(
    join(directory, "ios.json"),
    JSON.stringify({ at: new Date().toISOString(), harnessRevision: revision(), device, duration }, null, 2),
  )
  execFileSync(
    "xcrun",
    [
      "xctrace",
      "record",
      "--template",
      "Power Profiler",
      "--device",
      device,
      "--all-processes",
      "--time-limit",
      duration,
      "--output",
      output,
    ],
    { stdio: "inherit" },
  )
  writeFileSync(join(directory, "ios-toc.xml"), read("xcrun", ["xctrace", "export", "--input", output, "--toc"]))
  console.log(output)
  console.log("A paired debugger affects sleep. Use an untethered on-device Performance Trace to verify idle power.")
} else {
  throw new Error(usage)
}
