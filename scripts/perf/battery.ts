#!/usr/bin/env node
// Usage: battery.ts run <label>
//        battery.ts compare <before-label> <after-label>
// Measures what the phone app spends while agents stream on the desktop: its CPU time and the bytes on its socket,
// in the foreground on Home and in the background. See "Battery" in scripts/perf/README.md.
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { connect, createServer, type Socket } from "node:net"
import { loadavg } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import WebSocket from "ws"

type Phase = { cpuMs: number; seconds: number; bytesDown: number; bytesUp: number; activeSeconds: number }
type Result = { label: string; platform: string; streams: number; loadavg: number[]; phases: Record<string, Phase> }

interface Device {
  /** Points the app at the proxy and opens it. */
  open(pairingUrl: string): void
  /** The app's CPU time so far, in milliseconds. */
  cpuMs(): number
  background(): void
  foreground(): void
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..")
const resultsDir = join(root, ".context", "battery")
const [mode, label, other] = process.argv.slice(2)

const env = (name: string, fallback?: string) => {
  const value = process.env[name] ?? fallback
  if (value === undefined) throw new Error(`set ${name}; see "Battery" in scripts/perf/README.md`)
  return value
}
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const run = (command: string, ...args: string[]) => execFileSync(command, args, { encoding: "utf8" })
const between = (buckets: Map<number, number>, from: number, to: number) =>
  [...buckets].filter(([second]) => second >= from && second < to)
const median = (values: number[]) => values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)] ?? NaN

function android(serial: string, port: number): Device {
  const app = "com.hinadev.hinacode"
  const adb = (...args: string[]) => run("adb", "-s", serial, ...args)
  return {
    open(pairingUrl) {
      adb("reverse", `tcp:${port}`, `tcp:${port}`)
      adb("shell", "pm", "grant", app, "android.permission.POST_NOTIFICATIONS")
      adb("shell", "am", "start", "-a", "android.intent.action.VIEW", "-d", `'${pairingUrl}'`)
    },
    cpuMs() {
      const pid = adb("shell", "pidof", app).trim()
      // Fields after the command name, which sits in parentheses: utime and stime are the 12th and 13th.
      const fields = adb("shell", "cat", `/proc/${pid}/stat`).split(") ")[1]!.split(" ")
      const ticksPerSecond = 100
      return ((Number(fields[11]) + Number(fields[12])) * 1000) / ticksPerSecond
    },
    background: () => void adb("shell", "input", "keyevent", "KEYCODE_HOME"),
    foreground: () => void adb("shell", "am", "start", "-n", `${app}/.MainActivity`),
  }
}

function ios(udid: string, bundleId: string): Device {
  const pid = () => {
    const line = run("xcrun", "simctl", "spawn", udid, "launchctl", "list")
      .split("\n")
      .find((entry) => entry.includes(`UIKitApplication:${bundleId}[`))
    assert(line !== undefined, `${bundleId} is not running`)
    return line.split("\t")[0]!
  }
  return {
    open: (pairingUrl) => void run("xcrun", "simctl", "openurl", udid, pairingUrl),
    cpuMs() {
      // `ps` prints [[dd-]hh:]mm:ss.cc.
      const parts = run("ps", "-o", "cputime=", "-p", pid()).trim().split(/[-:]/).map(Number)
      return parts.reduce((total, part) => total * 60 + part, 0) * 1000
    },
    background: () => void run("xcrun", "simctl", "launch", udid, "com.apple.Preferences"),
    foreground: () => void run("xcrun", "simctl", "launch", udid, bundleId),
  }
}

/** Forwards `listen` to `target` and counts the bytes each way, per second. */
function proxy(listen: number, target: number) {
  const down = new Map<number, number>()
  const up = new Map<number, number>()
  const add = (buckets: Map<number, number>, bytes: number) => {
    const second = Math.floor(performance.now() / 1000)
    buckets.set(second, (buckets.get(second) ?? 0) + bytes)
  }
  const sockets = new Set<Socket>()
  const server = createServer((phone) => {
    const desktop = connect(target, "127.0.0.1")
    sockets.add(phone).add(desktop)
    phone.on("data", (chunk) => add(up, chunk.length))
    desktop.on("data", (chunk) => add(down, chunk.length))
    phone.pipe(desktop).pipe(phone)
    const end = () => (phone.destroy(), desktop.destroy(), sockets.delete(phone), sockets.delete(desktop))
    phone.on("close", end).on("error", end)
    desktop.on("close", end).on("error", end)
  }).listen(listen, "127.0.0.1")
  return {
    window(fromMs: number, toMs: number) {
      const [from, to] = [Math.floor(fromMs / 1000), Math.floor(toMs / 1000)]
      const sum = (buckets: Map<number, number>) => between(buckets, from, to).reduce((total, [, n]) => total + n, 0)
      const active = new Set([...between(down, from, to), ...between(up, from, to)].map(([second]) => second))
      return { bytesDown: sum(down), bytesUp: sum(up), activeSeconds: active.size }
    },
    connected: () => sockets.size > 0,
    close() {
      for (const socket of sockets) socket.destroy()
      server.close()
    },
  }
}

/** Keeps `count` mocked Claude threads busy: each sends its next prompt `gapMs` after its turn completes. */
async function load(port: number, token: string, count: number, gapMs: number) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/remote`)
  const pending = new Map<number, (result: unknown) => void>()
  const completed = new Set<(threadId: string) => void>()
  let nextId = 1
  let stopped = false
  const ready = new Promise<void>((resolve) =>
    ws.on("message", (raw) => {
      const frame = JSON.parse(String(raw))
      if (frame.type === "challenge") ws.send(JSON.stringify({ type: "auth", token }))
      else if (frame.type === "ready") resolve()
      else if (frame.type === "result") pending.get(frame.id)?.(frame.envelope.result)
      else if (
        frame.type === "event" &&
        frame.event.type === "thread.event" &&
        frame.event.event.type === "turn_completed"
      )
        for (const listener of completed) listener(frame.event.threadId)
    }),
  )
  const call = <T>(method: string, payload?: unknown) =>
    new Promise<T>((resolve) => {
      const id = nextId++
      pending.set(id, resolve as (result: unknown) => void)
      ws.send(JSON.stringify({ type: "call", id, method, ...(payload !== undefined && { payload }) }))
    })
  await ready
  const projects = await call<{ id: string; kind: string }[]>("projects.list")
  const project = projects.find((candidate) => candidate.kind === "chats") ?? projects[0]
  assert(project !== undefined, "the desktop has no project to start threads in")
  const threads = await Promise.all(
    Array.from({ length: count }, () => call<{ id: string }>("threads.create", { projectId: project.id })),
  )
  const send = (threadId: string) => {
    if (!stopped) void call("threads.send", { threadId, prompt: "go" })
  }
  completed.add((threadId) => {
    if (threads.some((thread) => thread.id === threadId)) setTimeout(() => send(threadId), gapMs)
  })
  for (const thread of threads) send(thread.id)
  return () => {
    stopped = true
    ws.close()
  }
}

async function measure(runLabel: string) {
  const platform = env("BATTERY_PLATFORM")
  const daemonPort = Number(env("BATTERY_DAEMON_PORT"))
  const proxyPort = Number(env("BATTERY_PROXY_PORT", "48199"))
  const token = env("BATTERY_TOKEN")
  const streams = Number(env("BATTERY_STREAMS", "3"))
  const foregroundMs = Number(env("BATTERY_FOREGROUND_MS", "60000"))
  const backgroundMs = Number(env("BATTERY_BACKGROUND_MS", "120000"))
  const settleMs = 10_000
  const device =
    platform === "android"
      ? android(env("BATTERY_SERIAL"), proxyPort)
      : ios(env("BATTERY_UDID"), env("BATTERY_BUNDLE_ID", "com.hinadev.hinacode"))

  const counter = proxy(proxyPort, daemonPort)
  device.open(`hinacode://connect?host=127.0.0.1&port=${proxyPort}&token=${token}`)
  for (let waited = 0; !counter.connected(); waited += 500) {
    assert(waited < 30_000, "the app did not connect to the proxy")
    await pause(500)
  }
  const stopLoad = await load(daemonPort, token, streams, Number(env("BATTERY_GAP_MS", "4000")))
  await pause(settleMs)

  const phases: Record<string, Phase> = {}
  const window = async (name: string, ms: number) => {
    const [cpu, at] = [device.cpuMs(), performance.now()]
    await pause(ms)
    const [cpuEnd, end] = [device.cpuMs(), performance.now()]
    phases[name] = { cpuMs: cpuEnd - cpu, seconds: (end - at) / 1000, ...counter.window(at, end) }
    console.log(name, phases[name])
  }
  await window("foreground", foregroundMs)
  device.background()
  await pause(settleMs)
  await window("background", backgroundMs)
  device.foreground()
  stopLoad()
  counter.close()

  const result: Result = { label: runLabel, platform, streams, loadavg: loadavg(), phases }
  mkdirSync(resultsDir, { recursive: true })
  writeFileSync(join(resultsDir, `${runLabel}.json`), JSON.stringify(result, null, 2))
}

/** Pools every `<label>-<n>.json` and prints the median of each phase per minute. */
function compare(before: string, after: string) {
  const runs = (prefix: string) =>
    readdirSync(resultsDir)
      .filter((file) => new RegExp(`^${prefix}-\\d+\\.json$`).test(file))
      .map((file) => JSON.parse(readFileSync(join(resultsDir, file), "utf8")) as Result)
  const perMinute = (results: Result[], phase: string, key: keyof Phase) =>
    median(results.map(({ phases }) => (phases[phase]![key] * 60) / phases[phase]!.seconds))
  const [a, b] = [runs(before), runs(after)]
  assert(a.length > 0 && b.length > 0, `no runs for ${a.length === 0 ? before : after} in ${resultsDir}`)
  const rows = ["foreground", "background"].flatMap((phase) =>
    (["cpuMs", "bytesDown", "bytesUp", "activeSeconds"] as const).map((key) => {
      const [x, y] = [perMinute(a, phase, key), perMinute(b, phase, key)]
      return {
        metric: `${phase} ${key}/min`,
        [before]: Math.round(x),
        [after]: Math.round(y),
        change: x === 0 ? "" : `${Math.round(((y - x) / x) * 100)}%`,
      }
    }),
  )
  console.log(`${before}: ${a.length} runs, ${after}: ${b.length} runs`)
  console.table(rows)
}

if (mode === "run" && label) await measure(label)
else if (mode === "compare" && label && other) compare(label, other)
else throw new Error("usage: battery.ts run <label> | battery.ts compare <before> <after>")
process.exit(0)
