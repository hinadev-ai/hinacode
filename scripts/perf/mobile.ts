#!/usr/bin/env node
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { loadavg } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

type Commit = { at: number; renderMs: number | null; rendered: Record<string, number> }
type Recording = { commits: Commit[]; frames: number[]; longTasks: { start: number; duration: number }[] }
type Result = Record<string, unknown> & Partial<Recording>

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..")
const resultsDir = join(root, ".context", "perf")
const [mode, label, other] = process.argv.slice(2)

const round1 = (value: number) => Math.round(value * 10) / 10
const quantile = (values: number[], q: number) => {
  if (values.length === 0) return 0
  const sorted = values.toSorted((a, b) => a - b)
  return round1(sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!)
}
const median = (values: number[]) => quantile(values, 0.5)
const spread = (values: number[]) => `${Math.min(...values)} to ${Math.max(...values)}`
const sum = (values: number[]) => round1(values.reduce((total, value) => total + value, 0))

function summarize({ commits = [], frames = [], longTasks = [] }: Partial<Recording>) {
  const gaps = frames.slice(1).map((at, index) => at - frames[index]!)
  const byComponent: Record<string, number> = {}
  for (const commit of commits)
    for (const [name, count] of Object.entries(commit.rendered)) byComponent[name] = (byComponent[name] ?? 0) + count
  const renders = Object.values(byComponent).reduce((total, count) => total + count, 0)
  const top = Object.fromEntries(
    Object.entries(byComponent)
      .toSorted(([, a], [, b]) => b - a)
      .slice(0, 12),
  )
  return {
    frames: { count: frames.length, p50: median(gaps), p95: quantile(gaps, 0.95), max: round1(Math.max(0, ...gaps)) },
    over33: gaps.filter((gap) => gap > 33.4).length,
    commits: commits.length,
    renders,
    renderMs: sum(commits.map((commit) => commit.renderMs ?? 0)),
    renderMsMax: round1(Math.max(0, ...commits.map((commit) => commit.renderMs ?? 0))),
    longTasks: longTasks.length,
    longTaskMs: sum(longTasks.map((task) => task.duration)),
    top,
  }
}

const lastMount = (commits: Commit[]) =>
  commits.findLast((commit) => Object.keys(commit.rendered).some((name) => name.endsWith("(mount)")))?.at ?? 0

const env = (name: string, fallback?: string) => {
  const value = process.env[name] ?? fallback
  if (value === undefined) throw new Error(`set ${name}; see "Profile the phone app" in scripts/perf/README.md`)
  return value
}

const simctl = (...args: string[]) => execFileSync("xcrun", ["simctl", ...args], { stdio: "ignore" })
const read = (request: IncomingMessage) =>
  new Promise<Record<string, unknown>>((resolve) => {
    let body = ""
    request.on("data", (chunk) => (body += chunk))
    request.on("end", () => resolve(body === "" ? {} : JSON.parse(body)))
  })

async function run(runLabel: string) {
  const udid = env("PERF_UDID")
  const app = env("PERF_APP")
  const port = Number(env("PERF_PORT", "8199"))
  const cdp = env("PERF_CDP")
  const longThread = env("PERF_LONG")
  const replyThread = env("PERF_REPLY")
  const rounds = Number(env("PERF_ROUNDS", "3"))
  const file = join(resultsDir, `${runLabel}-mobile.json`)
  assert(!existsSync(file), `${file} exists; pick a new label`)
  mkdirSync(resultsDir, { recursive: true })

  const rpc = (method: string, payload?: unknown) =>
    JSON.parse(
      execFileSync(
        "node",
        [join(root, ".agents/skills/verify-hinacode/scripts/rpc.ts"), String(cdp), method, JSON.stringify(payload)],
        { encoding: "utf8" },
      ),
    )
  const bundleId = execFileSync("plutil", ["-extract", "CFBundleIdentifier", "raw", join(app, "Info.plist")], {
    encoding: "utf8",
  }).trim()
  simctl("install", udid, app)

  let nextId = 1
  const queue: Record<string, unknown>[] = []
  let waiting: ServerResponse | null = null
  const results = new Map<number, (body: { ok: boolean; result?: Result; error?: string }) => void>()
  const readies = new Map<number, () => void>()
  let onHello: ((body: Record<string, unknown>) => void) | null = null

  const flush = () => {
    if (waiting === null || queue.length === 0) return
    waiting.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(queue.shift()))
    waiting = null
  }
  const server = createServer(async (request, response) => {
    if (request.url === "/next") {
      waiting?.writeHead(204).end()
      waiting = response
      setTimeout(() => {
        if (waiting !== response) return
        waiting = null
        response.writeHead(204).end()
      }, 20000)
      return flush()
    }
    const body = await read(request)
    response.writeHead(204).end()
    if (request.url === "/hello") onHello?.(body)
    if (request.url === "/ready") readies.get(Number(body.id))?.()
    if (request.url === "/result") results.get(Number(body.id))?.(body as never)
  })
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve))

  const send = (type: string, args: Record<string, unknown> = {}, onReady?: () => void) => {
    const id = nextId++
    if (onReady) readies.set(id, onReady)
    const done = new Promise<Result>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${type} timed out`)), 90000)
      results.set(id, (body) => {
        clearTimeout(timer)
        if (body.ok) resolve(body.result ?? {})
        else reject(new Error(`${type}: ${body.error}`))
      })
    })
    queue.push({ id, type, ...args })
    flush()
    return done
  }

  const launch = async () => {
    const hello = new Promise<Record<string, unknown>>((resolve) => (onHello = resolve))
    try {
      simctl("terminate", udid, bundleId)
    } catch {}
    const launchedAt = Date.now()
    simctl("launch", udid, bundleId)
    await hello
    return launchedAt
  }

  const loadStart = loadavg()
  const record: { meta: Record<string, unknown>; cold: unknown[]; rounds: unknown[]; raw: unknown[] } = {
    meta: {
      label: runLabel,
      app,
      bundle: createHash("sha256")
        .update(readFileSync(join(app, "main.jsbundle")))
        .digest("hex")
        .slice(0, 12),
      udid,
      rounds,
      revision: execFileSync("git", ["-C", root, "rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim(),
      date: new Date().toISOString(),
    },
    cold: [],
    rounds: [],
    raw: [],
  }

  await launch()
  let hello = await send("hello")
  if (!hello.paired) {
    await send("pair", { target: rpc("remote.pairing") })
    hello = await send("hello")
  }
  record.meta.longTasksObserved = hello.longTasksObserved

  for (let round = 0; round < rounds; round++) {
    const launchedAt = await launch()
    const result = await send("hello")
    const sinceLaunch = (at: unknown) => round1(Number(result.epochOffset) + Number(at) - launchedAt)
    const startup = result.startup as {
      startTime: number
      executeJavaScriptBundleEntryPointStart: number
      endTime: number
    }
    record.cold.push({
      launchToRuntimeMs: sinceLaunch(startup.startTime),
      bundleMs: round1(startup.endTime - startup.executeJavaScriptBundleEntryPointStart),
      launchToFirstCommitMs: sinceLaunch(result.firstCommit),
      launchToThreadListMs: sinceLaunch(result.threadListPainted),
    })
    console.log(`cold ${round + 1}/${rounds}`, JSON.stringify(record.cold.at(-1)))
  }

  for (let round = 0; round < rounds; round++) {
    const list = await send("scroll", { testID: "home-list", px: 30, frames: 120 })
    const opened = await send("open", { threadId: longThread })
    const transcript = await send("scroll", { testID: "transcript", px: 40, frames: 180 })
    const typing = await send("type", {
      text: "Refactor the transcript list so each message measures once.",
      intervalMs: 50,
    })
    await send("back")
    await send("open", { threadId: replyThread })
    const replied = await send("reply", { threadId: replyThread }, () =>
      rpc("threads.send", { threadId: replyThread, prompt: "go" }),
    )
    await send("back")

    const keys = typing.keys as { at: number; commit: number | null; paint: number }[]
    const keyCommits = keys.filter((key) => key.commit !== null).map((key) => key.commit! - key.at)
    const typed = summarize(typing)
    const entry = {
      threadListScroll: summarize(list),
      open: {
        fetchMs: round1(Number(opened.loaded) - Number(opened.start)),
        firstPaintMs: round1(Number(opened.painted) - Number(opened.start)),
        mountedMs: round1(lastMount(opened.commits ?? []) - Number(opened.start)),
        ...summarize(opened),
      },
      transcriptScroll: summarize(transcript),
      typing: {
        keys: keys.length,
        keyToCommit: { p50: median(keyCommits), p95: quantile(keyCommits, 0.95) },
        keyToPaint: {
          p50: median(keys.map((key) => key.paint - key.at)),
          p95: quantile(
            keys.map((key) => key.paint - key.at),
            0.95,
          ),
        },
        rendersPerKey: round1(typed.renders / keys.length),
        renderMsPerKey: round1(typed.renderMs / keys.length),
        ...typed,
      },
      reply: {
        doneToPaintMs: round1(Number(replied.painted) - Number(replied.done)),
        ...summarize(replied),
      },
    }
    record.rounds.push(entry)
    record.raw.push({ list, opened, transcript, typing, replied })
    console.log(`round ${round + 1}/${rounds}`, JSON.stringify(headline(entry)))
  }
  record.meta.load = { start: loadStart, end: loadavg() }
  writeFileSync(file, JSON.stringify(record, null, 2))
  console.log(`wrote ${file}`)
  server.close()
}

type Entry = {
  threadListScroll: ReturnType<typeof summarize>
  open: ReturnType<typeof summarize> & { fetchMs: number; firstPaintMs: number; mountedMs: number }
  transcriptScroll: ReturnType<typeof summarize>
  typing: ReturnType<typeof summarize> & {
    keyToCommit: { p50: number; p95: number }
    keyToPaint: { p50: number; p95: number }
    rendersPerKey: number
    renderMsPerKey: number
  }
  reply: ReturnType<typeof summarize> & { doneToPaintMs: number }
}
type Cold = { launchToRuntimeMs: number; bundleMs: number; launchToFirstCommitMs: number; launchToThreadListMs: number }

function headline(entry: Entry) {
  return {
    "thread list scroll: frame p95 ms": entry.threadListScroll.frames.p95,
    "thread list scroll: frames over 33 ms": entry.threadListScroll.over33,
    "open long thread: transcript fetched ms": entry.open.fetchMs,
    "open long thread: first paint ms": entry.open.firstPaintMs,
    "open long thread: last mount ms": entry.open.mountedMs,
    "open long thread: render ms": entry.open.renderMs,
    "open long thread: longest commit render ms": entry.open.renderMsMax,
    "open long thread: component renders": entry.open.renders,
    "open long thread: long task ms": entry.open.longTaskMs,
    "transcript scroll: frame p95 ms": entry.transcriptScroll.frames.p95,
    "transcript scroll: frames over 33 ms": entry.transcriptScroll.over33,
    "transcript scroll: render ms": entry.transcriptScroll.renderMs,
    "transcript scroll: longest commit render ms": entry.transcriptScroll.renderMsMax,
    "thread list scroll: render ms": entry.threadListScroll.renderMs,
    "typing: key to commit p50 ms": entry.typing.keyToCommit.p50,
    "typing: key to paint p95 ms": entry.typing.keyToPaint.p95,
    "typing: component renders per key": entry.typing.rendersPerKey,
    "typing: render ms per key": entry.typing.renderMsPerKey,
    "reply: frame p95 ms": entry.reply.frames.p95,
    "reply: frames over 33 ms": entry.reply.over33,
    "reply: component renders": entry.reply.renders,
    "reply: render ms": entry.reply.renderMs,
    "reply: longest commit render ms": entry.reply.renderMsMax,
    "reply: done to paint ms": entry.reply.doneToPaintMs,
  }
}

function metrics(prefix: string) {
  const pattern = new RegExp(`^${prefix}(-\\d+)?-mobile\\.json$`)
  const files = readdirSync(resultsDir).filter((name) => pattern.test(name))
  assert(files.length > 0, `no runs for ${prefix} in ${resultsDir}`)
  const records = files.map((name) => JSON.parse(readFileSync(join(resultsDir, name), "utf8")))
  const cold: Cold[] = records.flatMap((record) => record.cold)
  const rows: Record<string, number[]> = {
    "cold start: launch to JS runtime ms": cold.map((start) => start.launchToRuntimeMs),
    "cold start: bundle evaluation ms": cold.map((start) => start.bundleMs),
    "cold start: launch to first commit ms": cold.map((start) => start.launchToFirstCommitMs),
    "cold start: launch to thread list ms": cold.map((start) => start.launchToThreadListMs),
  }
  for (const entry of records.flatMap((record) => record.rounds as Entry[]))
    for (const [name, value] of Object.entries(headline(entry))) (rows[name] ??= []).push(value)
  return {
    runs: files.length,
    values: Object.fromEntries(
      Object.entries(rows).map(([name, values]) => [name, { median: median(values), values }]),
    ),
  }
}

if (mode === "run" && label) await run(label)
else if (mode === "compare" && label && other) {
  const before = metrics(label)
  const after = metrics(other)
  console.log(`${label}: ${before.runs} runs, ${other}: ${after.runs} runs`)
  console.log(`| Measurement | ${label} | ${other} | Change | ${label} spread | ${other} spread |`)
  console.log("| --- | ---: | ---: | ---: | --- | --- |")
  for (const [name, { median: a, values: va }] of Object.entries(before.values)) {
    const b = after.values[name]
    if (b === undefined) continue
    const change = a === 0 ? "" : `${Math.round(((b.median - a) / a) * 100)}%`
    console.log(`| ${name} | ${a} | ${b.median} | ${change} | ${spread(va)} | ${spread(b.values)} |`)
  }
} else if (mode === "summary" && label) {
  const { runs, values } = metrics(label)
  console.log(`${label}: ${runs} runs`)
  for (const [name, { median: value, values: all }] of Object.entries(values))
    console.log(`${name}: ${value} (${all.join(", ")})`)
} else {
  console.error("usage: mobile.ts run <label> | summary <label> | compare <before-label> <after-label>")
  process.exit(2)
}
