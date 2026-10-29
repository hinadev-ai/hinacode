#!/usr/bin/env node
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { connect, createServer, type Socket } from "node:net"
import { loadavg } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { Effect, Schema } from "effect"
import { WebSocket } from "ws"
import { ServerFrame } from "../../src/shared/remote.ts"

const Phase = Schema.Struct({
  cpuMs: Schema.Number,
  seconds: Schema.Number,
  bytesDown: Schema.Number,
  bytesUp: Schema.Number,
  framesDown: Schema.Number,
  activeSeconds: Schema.Number,
  completedTurns: Schema.Number.pipe(Schema.withDecodingDefaultKey(Effect.succeed(0))),
})
type Phase = typeof Phase.Type
const Result = Schema.Struct({
  label: Schema.String,
  platform: Schema.Literals(["android", "ios"]),
  streams: Schema.Int,
  loadavg: Schema.Array(Schema.Number),
  phases: Schema.Record(Schema.String, Phase),
})
type Result = typeof Result.Type
const decodeResult = Schema.decodeUnknownSync(Result)
const decodeFrame = Schema.decodeUnknownSync(ServerFrame)
const decodeProjects = Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ id: Schema.String, kind: Schema.String })))
const decodeThread = Schema.decodeUnknownSync(Schema.Struct({ id: Schema.String }))

interface Device {
  open(pairingUrl: string): void
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

const add = (buckets: Map<number, number>, count: number) => {
  const second = Math.floor(performance.now() / 1000)
  buckets.set(second, (buckets.get(second) ?? 0) + count)
}
const perMinute = (results: Result[], phase: string, key: keyof Phase) =>
  median(results.map(({ phases }) => (phases[phase]![key] * 60) / phases[phase]!.seconds))

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
      const [first, clock] = run("ps", "-o", "cputime=", "-p", pid()).trim().split("-")
      const days = clock === undefined ? 0 : Number(first)
      const parts = (clock ?? first!).split(":").map(Number)
      return days * 86_400_000 + parts.reduce((total, part) => total * 60 + part, 0) * 1000
    },
    background: () => void run("xcrun", "simctl", "launch", udid, "com.apple.Preferences"),
    foreground: () => void run("xcrun", "simctl", "launch", udid, bundleId),
  }
}

/**
 * Counts the WebSocket frames in a server's byte stream after its upgrade response. Server frames are unmasked, and
 * their headers stay readable when permessage-deflate compresses the payload.
 */
function frameCounter(onFrame: () => void) {
  let buffer = Buffer.alloc(0)
  let upgraded = false
  return (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk])
    if (!upgraded) {
      const end = buffer.indexOf("\r\n\r\n")
      if (end === -1) return
      upgraded = true
      buffer = buffer.subarray(end + 4)
    }
    while (buffer.length >= 2) {
      const short = buffer[1]! & 0x7f
      const header = short === 126 ? 4 : short === 127 ? 10 : 2
      if (buffer.length < header) return
      const length = short === 126 ? buffer.readUInt16BE(2) : short === 127 ? Number(buffer.readBigUInt64BE(2)) : short
      if (buffer.length < header + length) return
      buffer = buffer.subarray(header + length)
      onFrame()
    }
  }
}

function proxy(listen: number, target: number) {
  const down = new Map<number, number>()
  const up = new Map<number, number>()
  const frames = new Map<number, number>()
  const sockets = new Set<Socket>()
  const server = createServer((phone) => {
    const desktop = connect(target, "127.0.0.1")
    sockets.add(phone).add(desktop)
    phone.on("data", (chunk) => add(up, chunk.length))
    const countFrames = frameCounter(() => add(frames, 1))
    desktop.on("data", (chunk: Buffer) => (add(down, chunk.length), countFrames(chunk)))
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
      return { bytesDown: sum(down), bytesUp: sum(up), framesDown: sum(frames), activeSeconds: active.size }
    },
    connected: () => sockets.size > 0,
    close() {
      for (const socket of sockets) socket.destroy()
      server.close()
    },
  }
}

async function load(port: number, token: string, count: number, gapMs: number) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/remote`)
  const pending = new Map<number, (result: unknown) => void>()
  const completed = new Set<(threadId: string) => void>()
  const completions = new Map<string, number>()
  let nextId = 1
  let stopped = false
  const ready = new Promise<void>((resolve) =>
    ws.on("message", (raw) => {
      const frame = decodeFrame(JSON.parse(String(raw)))
      if (frame.type === "challenge") ws.send(JSON.stringify({ type: "auth", token }))
      else if (frame.type === "ready") resolve()
      else if (frame.type === "result") {
        const complete = pending.get(frame.id)
        pending.delete(frame.id)
        if ("error" in frame.envelope) throw new Error(`load RPC failed: ${JSON.stringify(frame.envelope.error)}`)
        complete?.(frame.envelope.result)
      } else if (frame.type === "event" && frame.event.type === "thread.event") {
        const { threadId, event } = frame.event
        if (!completions.has(threadId)) return
        assert(
          event.type !== "turn_failed" && event.type !== "turn_limited",
          `mock workload ${event.type}: ${threadId}`,
        )
        if (event.type === "turn_completed") {
          completions.set(threadId, completions.get(threadId)! + 1)
          for (const listener of completed) listener(threadId)
        }
      }
    }),
  )
  ws.on("error", (error) => {
    throw error
  })
  ws.on("close", () => assert(stopped, "mock workload lost its daemon connection"))
  const call = (method: string, payload?: unknown) =>
    new Promise<unknown>((resolve) => {
      const id = nextId++
      pending.set(id, resolve)
      ws.send(JSON.stringify({ type: "call", id, method, ...(payload !== undefined && { payload }) }))
    })
  await ready
  const projects = decodeProjects(await call("projects.list"))
  const project = projects.find((candidate) => candidate.kind === "chats") ?? projects[0]
  assert(project !== undefined, "the desktop has no project to start threads in")
  const threads = await Promise.all(
    Array.from({ length: count }, async () => decodeThread(await call("threads.create", { projectId: project.id }))),
  )
  for (const { id } of threads) completions.set(id, 0)
  const send = (threadId: string) => {
    if (!stopped) void call("threads.send", { threadId, prompt: "go" })
  }
  completed.add((threadId) => {
    if (threads.some((thread) => thread.id === threadId)) setTimeout(() => send(threadId), gapMs)
  })
  for (const thread of threads) send(thread.id)
  return {
    completions,
    stop() {
      stopped = true
      ws.close()
    },
  }
}

async function measure(runLabel: string) {
  const platform = env("BATTERY_PLATFORM")
  assert(platform === "android" || platform === "ios", "BATTERY_PLATFORM must be android or ios")
  const daemonPort = Number(env("BATTERY_DAEMON_PORT"))
  const proxyPort = Number(env("BATTERY_PROXY_PORT", "48199"))
  const token = env("BATTERY_TOKEN")
  const streams = Number(env("BATTERY_STREAMS", "3"))
  const foregroundMs = Number(env("BATTERY_FOREGROUND_MS", "60000"))
  const backgroundMs = Number(env("BATTERY_BACKGROUND_MS", "120000"))
  assert(Number.isInteger(streams) && streams >= 0, "BATTERY_STREAMS must be a nonnegative integer")
  assert(foregroundMs > 0 && backgroundMs > 0, "measurement durations must be positive")
  const settleMs = 10_000
  const device =
    platform === "android"
      ? android(env("BATTERY_SERIAL"), proxyPort)
      : ios(env("BATTERY_UDID"), env("BATTERY_BUNDLE_ID", "com.hinadev.hinacode"))

  const counter = proxy(proxyPort, daemonPort)
  const phases: Record<string, Phase> = {}
  let workload: Awaited<ReturnType<typeof load>> | undefined
  const window = async (name: string, ms: number) => {
    assert(workload !== undefined)
    const completedBefore = new Map(workload.completions)
    console.log(`${name}: sampling ${ms / 1000} seconds`)
    const [cpu, at] = [device.cpuMs(), performance.now()]
    await pause(ms)
    const [cpuEnd, end] = [device.cpuMs(), performance.now()]
    let completedTurns = 0
    for (const [threadId, completed] of workload.completions) {
      const turns = completed - completedBefore.get(threadId)!
      assert(turns > 0, `${threadId} completed no mock turns during ${name}; reject this capture`)
      completedTurns += turns
    }
    phases[name] = { cpuMs: cpuEnd - cpu, seconds: (end - at) / 1000, completedTurns, ...counter.window(at, end) }
    console.log(name, phases[name])
  }
  try {
    console.log(`${runLabel}: pairing ${platform}`)
    device.open(`hinacode://connect?host=127.0.0.1&port=${proxyPort}&token=${token}`)
    for (let waited = 0; !counter.connected(); waited += 500) {
      assert(waited < 90_000, "the app did not connect to the proxy")
      await pause(500)
    }
    workload = await load(daemonPort, token, streams, Number(env("BATTERY_GAP_MS", "4000")))
    await pause(settleMs)
    await window("foreground", foregroundMs)
    assert(phases.foreground!.framesDown > 0, "no frames received; verify pairing before comparing this run")
    device.background()
    await pause(settleMs)
    await window("background", backgroundMs)
    device.foreground()
  } finally {
    workload?.stop()
    counter.close()
  }

  const result: Result = { label: runLabel, platform, streams, loadavg: loadavg(), phases }
  mkdirSync(resultsDir, { recursive: true })
  writeFileSync(join(resultsDir, `${runLabel}.json`), JSON.stringify(result, null, 2))
}

function compare(before: string, after: string, checkBudget: boolean) {
  const manifest = process.env.BATTERY_RESULTS_FILE
  const saved =
    manifest === undefined
      ? undefined
      : Schema.decodeUnknownSync(Schema.Struct({ captures: Schema.Array(Result) }))(
          JSON.parse(readFileSync(manifest, "utf8")),
        ).captures
  const runs = (prefix: string) =>
    (
      saved?.filter((capture) => new RegExp(`^${prefix}-\\d+$`).test(capture.label)) ??
      readdirSync(resultsDir)
        .filter((file) => new RegExp(`^${prefix}-\\d+\\.json$`).test(file))
        .map((file) => decodeResult(JSON.parse(readFileSync(join(resultsDir, file), "utf8"))))
    ).map((capture) => {
      for (const phase of ["foreground", "background"]) {
        const sample = capture.phases[phase]
        assert(sample !== undefined && sample.seconds > 0, `${capture.label}: invalid ${phase} duration`)
        assert(
          Object.values(sample).every((value) => Number.isFinite(value) && value >= 0),
          `${capture.label}: invalid sample`,
        )
      }
      return capture
    })
  const [a, b] = [runs(before), runs(after)]
  assert(a.length > 0 && b.length > 0, `no runs for ${a.length === 0 ? before : after} in ${resultsDir}`)
  const baseline = a[0]!
  assert(
    [...a, ...b].every((capture) => capture.platform === baseline.platform && capture.streams === baseline.streams),
    "compare the same platform and stream count",
  )
  const rows = ["foreground", "background"].flatMap((phase) =>
    (["cpuMs", "bytesDown", "bytesUp", "framesDown", "activeSeconds"] as const).map((key) => {
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
  for (const [name, results] of [
    [before, a],
    [after, b],
  ] as const) {
    const hostLoads = results.map((result) => result.loadavg[0]!)
    console.log(`${name}: host load ${Math.min(...hostLoads).toFixed(1)} to ${Math.max(...hostLoads).toFixed(1)}`)
    for (const phase of ["foreground", "background"]) {
      const cpu = results.map(({ phases }) => (phases[phase]!.cpuMs * 60) / phases[phase]!.seconds)
      console.log(`${name} ${phase}: CPU ${Math.round(Math.min(...cpu))} to ${Math.round(Math.max(...cpu))} ms/min`)
    }
  }
  if (!checkBudget) return
  assert(a.length >= 3 && b.length >= 3, "the budget check requires at least three runs per build")
  const budgets: Array<{ phase: string; key: keyof Phase }> = [
    { phase: "foreground", key: "framesDown" },
    { phase: "background", key: "bytesDown" },
  ]
  if (baseline.platform === "android") budgets.push({ phase: "background", key: "cpuMs" })
  for (const { phase, key } of budgets) {
    const [beforeValue, afterValue] = [perMinute(a, phase, key), perMinute(b, phase, key)]
    assert(beforeValue > 0 && Number.isFinite(afterValue), `${phase} ${key}: no measurable baseline or candidate`)
    assert(afterValue <= beforeValue * 0.1, `${phase} ${key}: reduction is below the 90% budget`)
    console.log(`PASS ${phase} ${key}: ${Math.round((1 - afterValue / beforeValue) * 100)}% reduction`)
  }
  if (baseline.platform === "ios")
    console.log("iOS background CPU requires a physical device; simulator CPU is suspended")
}

if (mode === "load") {
  const workload = await load(
    Number(env("BATTERY_DAEMON_PORT")),
    env("BATTERY_TOKEN"),
    Number(env("BATTERY_STREAMS", "3")),
    Number(env("BATTERY_GAP_MS", "4000")),
  )
  console.log("Mock workload running. Stop with Ctrl-C after collecting the device traces.")
  await new Promise<void>((resolve) => {
    const finish = () => {
      workload.stop()
      resolve()
    }
    process.once("SIGINT", finish)
    process.once("SIGTERM", finish)
  })
} else if (mode === "run" && label) await measure(label)
else if ((mode === "compare" || mode === "check") && label && other) compare(label, other, mode === "check")
else
  throw new Error(
    "usage: battery.ts run <label> | battery.ts compare <before> <after> | battery.ts check <before> <after> | battery.ts load",
  )
process.exit(0)
