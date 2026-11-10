#!/usr/bin/env node
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { loadavg } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { setTimeout as sleep } from "node:timers/promises"
import { type DocumentSize, documentSizes, withFirstScreenParagraphChanged } from "./documents.ts"

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

const run = (command: string, args: string[]) =>
  execFileSync(command, args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 })
const sha = (data: Buffer | string) => createHash("sha256").update(data).digest("hex").slice(0, 12)

type GfxInfo = Record<string, number>
const numberAfter = (pattern: RegExp, text: string) => Number(pattern.exec(text)?.[1] ?? Number.NaN)
type Device = {
  platform: "ios" | "android"
  id: string
  app: string
  bundle: string
  connect(ports: number[]): void
  launch(): number
  terminate(): void
  memoryBytes(pid: number): number
  fling(count: number, intervalMs: number): Promise<void>
  frameStats?: { reset(): void; read(): GfxInfo }
}

function iosDevice(): Device {
  const udid = env("PERF_UDID")
  const app = env("PERF_APP")
  const bundleId = run("plutil", ["-extract", "CFBundleIdentifier", "raw", join(app, "Info.plist")]).trim()
  const swipe = "swipe --start-x 200 --start-y 800 --end-x 200 --end-y 150 --duration 0.12"
  return {
    platform: "ios",
    id: udid,
    app,
    bundle: sha(readFileSync(join(app, "main.jsbundle"))),
    connect: () => run("xcrun", ["simctl", "install", udid, app]),
    launch: () => Number(run("xcrun", ["simctl", "launch", udid, bundleId]).trim().split(": ").at(-1)),
    terminate: () => {
      try {
        execFileSync("xcrun", ["simctl", "terminate", udid, bundleId], { stdio: "ignore" })
      } catch {}
    },
    memoryBytes: (pid) => Number(/Footprint: (\d+) B/.exec(run("footprint", ["-f", "bytes", "-p", String(pid)]))![1]),
    fling: async (count, intervalMs) => {
      const pause = `sleep ${(intervalMs - 120) / 1000}`
      const steps = Array.from({ length: count }, () => ["--step", swipe, "--step", pause]).flat()
      run("axe", ["batch", "--udid", udid, ...steps])
    },
  }
}

function androidDevice(): Device {
  const serial = env("PERF_SERIAL")
  const apk = env("PERF_APK")
  const pkg = env("PERF_PACKAGE", "com.hinadev.hinacode")
  const adb = (...args: string[]) => run("adb", ["-s", serial, ...args])
  return {
    platform: "android",
    id: serial,
    app: apk,
    bundle: sha(run("unzip", ["-p", apk, "assets/index.android.bundle"])),
    connect: (ports) => {
      adb("install", "-r", apk)
      adb("shell", "pm", "grant", pkg, "android.permission.POST_NOTIFICATIONS")
      for (const port of ports) adb("reverse", `tcp:${port}`, `tcp:${port}`)
    },
    launch: () => {
      adb("shell", "am", "start", "-W", "-n", `${pkg}/.MainActivity`)
      return Number(adb("shell", "pidof", pkg).trim())
    },
    terminate: () => void adb("shell", "am", "force-stop", pkg),
    memoryBytes: () => numberAfter(/TOTAL PSS:\s+(\d+)/, adb("shell", "dumpsys", "meminfo", pkg)) * 1024,
    fling: async (count, intervalMs) => {
      for (let swipe = 0; swipe < count; swipe++) {
        const startedAt = Date.now()
        adb("shell", "input", "swipe", "540", "1800", "540", "300", "80")
        await sleep(Math.max(0, intervalMs - (Date.now() - startedAt)))
      }
    },
    frameStats: {
      reset: () => void adb("shell", "dumpsys", "gfxinfo", pkg, "reset"),
      read: () => {
        const text = adb("shell", "dumpsys", "gfxinfo", pkg)
        return {
          frames: numberAfter(/Total frames rendered: (\d+)/, text),
          janky: numberAfter(/Janky frames: (\d+)/, text),
          p50: numberAfter(/50th percentile: (\d+)ms/, text),
          p90: numberAfter(/90th percentile: (\d+)ms/, text),
          p95: numberAfter(/95th percentile: (\d+)ms/, text),
          p99: numberAfter(/99th percentile: (\d+)ms/, text),
        }
      },
    },
  }
}

const VSYNC_MS = 1000 / 60
function nativeFrames(timestamps: number[]) {
  const gaps = timestamps.slice(1).map((at, index) => at - timestamps[index]!)
  return {
    count: timestamps.length,
    p50: median(gaps),
    p95: quantile(gaps, 0.95),
    max: round1(Math.max(0, ...gaps)),
    overOneAndHalfVsync: gaps.filter((gap) => gap > VSYNC_MS * 1.5).length,
    over32: gaps.filter((gap) => gap > 32).length,
  }
}

const read = (request: IncomingMessage) =>
  new Promise<Record<string, unknown>>((resolve) => {
    let body = ""
    request.on("data", (chunk) => (body += chunk))
    request.on("end", () => resolve(body === "" ? {} : JSON.parse(body)))
  })

async function measure(runLabel: string) {
  const device = env("PERF_PLATFORM", "ios") === "android" ? androidDevice() : iosDevice()
  const port = Number(env("PERF_PORT", "8199"))
  const cdp = env("PERF_CDP")
  const rounds = Number(env("PERF_ROUNDS", "3"))
  const workloads = new Set(env("PERF_WORKLOADS", "cold,threads").split(","))
  const file = join(resultsDir, `${runLabel}-mobile.json`)
  assert(!existsSync(file), `${file} exists; pick a new label`)
  mkdirSync(resultsDir, { recursive: true })

  const rpc = (method: string, payload?: unknown) =>
    JSON.parse(
      run("node", [
        join(root, ".agents/skills/verify-hinacode/scripts/rpc.ts"),
        String(cdp),
        method,
        JSON.stringify(payload),
      ]),
    )
  const pairing = rpc("remote.pairing") as { port: number }
  device.connect([port, pairing.port])

  let nextId = 1
  const queue: Record<string, unknown>[] = []
  let waiting: ServerResponse | null = null
  const results = new Map<number, (body: { ok: boolean; result?: Result; error?: string }) => void>()
  const readies = new Map<number, () => unknown>()
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
    if (request.url === "/ready") await Promise.resolve(readies.get(Number(body.id))?.()).catch(console.error)
    response.writeHead(204).end()
    if (request.url === "/hello") onHello?.(body)
    if (request.url === "/result") results.get(Number(body.id))?.(body as never)
  })
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve))

  const send = (type: string, args: Record<string, unknown> = {}, onReady?: () => unknown) => {
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

  let pid = 0
  const launch = async () => {
    const hello = new Promise<Record<string, unknown>>((resolve) => (onHello = resolve))
    device.terminate()
    const launchedAt = Date.now()
    pid = device.launch()
    await hello
    return launchedAt
  }

  const loadStart = loadavg()
  const record: {
    meta: Record<string, unknown>
    cold: unknown[]
    rounds: unknown[]
    documents: unknown[]
    documentLarge: unknown[]
    raw: unknown[]
  } = {
    meta: {
      label: runLabel,
      platform: device.platform,
      device: device.id,
      app: device.app,
      bundle: device.bundle,
      rounds,
      workloads: [...workloads],
      revision: run("git", ["-C", root, "rev-parse", "--short", "HEAD"]).trim(),
      date: new Date().toISOString(),
    },
    cold: [],
    rounds: [],
    documents: [],
    documentLarge: [],
    raw: [],
  }

  await launch()
  let hello = await send("hello")
  if (!hello.paired) {
    await send("pair", { target: rpc("remote.pairing") })
    hello = await send("hello")
  }
  record.meta.longTasksObserved = hello.longTasksObserved

  for (let round = 0; workloads.has("cold") && round < rounds; round++) {
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

  for (let round = 0; workloads.has("threads") && round < rounds; round++) {
    const longThread = env("PERF_LONG")
    const replyThread = env("PERF_REPLY")
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

  if (workloads.has("documents")) {
    const threadId = env("PERF_DOC_THREAD")
    const docs = Object.fromEntries(
      env("PERF_DOCS")
        .split(",")
        .map((pair) => pair.split(":")),
    ) as Record<DocumentSize, string>
    const flings = Number(env("PERF_FLINGS", "10"))
    const openDocument = async (size: DocumentSize) => {
      const opened = await send("openDocument", { threadId, artifactId: docs[size] })
      record.raw.push({ size, opened })
      return opened
    }
    for (let round = 0; round < rounds; round++)
      for (const size of Object.keys(documentSizes) as DocumentSize[]) {
        const entry = documentOpenEntry(size, await openDocument(size))
        await send("back")
        record.documents.push(entry)
        console.log(`document ${round + 1}/${rounds}`, JSON.stringify(documentOpenHeadline(entry)))
      }

    await openDocument("large")
    await sleep(1000)
    const memoryBytes = device.memoryBytes(pid)
    device.frameStats?.reset()
    let flingMs = 0
    const flung = await send("fling", {}, async () => {
      const startedAt = Date.now()
      await device.fling(flings, 600)
      flingMs = Date.now() - startedAt
      await sleep(1000)
    })
    const gfxinfo = device.frameStats?.read() ?? null
    if ((flung.commits ?? []).length < 2)
      console.warn("the fling committed nothing; check that a dialog is not covering the document")
    const updated = await send("updateDocument", { artifactId: docs.large }, () => {
      const { revision, markdown } = rpc("artifacts.readDocument", { id: docs.large })
      rpc("artifacts.saveDocument", {
        id: docs.large,
        baseRevision: revision,
        markdown: withFirstScreenParagraphChanged(markdown, runLabel),
      })
    })
    await send("back")
    const large = {
      memoryMB: round1(memoryBytes / 1048576),
      fling: {
        flings,
        flingMs,
        native: nativeFrames((flung.nativeFrames as number[]) ?? []),
        gfxinfo,
        ...summarize(flung),
      },
      update: {
        eventToPaintMs: updated.paintedAt === null ? null : round1(Number(updated.paintedAt) - Number(updated.eventAt)),
        eventToSettledMs: round1(Number(updated.settled) - Number(updated.eventAt)),
        ...summarize(updated),
      },
    }
    record.documentLarge.push(large)
    record.raw.push({ flung, updated })
    console.log("document large", JSON.stringify(documentLargeHeadline(large)))
  }

  record.meta.load = { start: loadStart, end: loadavg() }
  writeFileSync(file, JSON.stringify(record, null, 2))
  console.log(`wrote ${file}`)
  device.terminate()
  server.close()
}

function documentOpenEntry(size: DocumentSize, opened: Result) {
  const start = Number(opened.start)
  const heap = opened.heap as { heapSize: number; allocatedBytes: number } | null
  return {
    size,
    bytes: Number(opened.bytes),
    segments: Number(opened.segments),
    firstContentMs: round1(Number(opened.firstContent) - start),
    interactiveMs: round1(Number(opened.settled) - start),
    segmentMs: round1(Number(opened.segmentMs)),
    heapMB: heap === null ? null : round1(heap.heapSize / 1048576),
    allocatedMB: heap === null ? null : round1(heap.allocatedBytes / 1048576),
    ...summarize(opened),
  }
}
type DocumentOpen = ReturnType<typeof documentOpenEntry>
type DocumentLarge = {
  memoryMB: number
  fling: ReturnType<typeof summarize> & { native: ReturnType<typeof nativeFrames>; gfxinfo: GfxInfo | null }
  update: ReturnType<typeof summarize> & { eventToPaintMs: number | null; eventToSettledMs: number }
}

function documentOpenHeadline(entry: DocumentOpen) {
  const name = `document ${entry.size}`
  return {
    [`${name}: first content ms`]: entry.firstContentMs,
    [`${name}: interactive ms`]: entry.interactiveMs,
    [`${name}: JS segment ms`]: entry.segmentMs,
    [`${name}: Hermes heap MB`]: entry.heapMB,
    [`${name}: render ms`]: entry.renderMs,
    [`${name}: longest commit render ms`]: entry.renderMsMax,
    [`${name}: component renders`]: entry.renders,
    [`${name}: JS frames over 33 ms`]: entry.over33,
  }
}

function documentLargeHeadline({ memoryMB, fling, update }: DocumentLarge) {
  return {
    "document large: memory MB": memoryMB,
    "document fling: native frame p50 ms": fling.native.p50,
    "document fling: native frame p95 ms": fling.native.p95,
    "document fling: native frame max ms": fling.native.max,
    "document fling: native frames over 25 ms": fling.native.overOneAndHalfVsync,
    "document fling: native frames over 32 ms": fling.native.over32,
    "document fling: JS frame p95 ms": fling.frames.p95,
    "document fling: render ms": fling.renderMs,
    "document fling: gfxinfo janky frames": fling.gfxinfo?.janky ?? null,
    "document fling: gfxinfo p90 ms": fling.gfxinfo?.p90 ?? null,
    "document fling: gfxinfo p99 ms": fling.gfxinfo?.p99 ?? null,
    "document update: event to paint ms": update.eventToPaintMs,
    "document update: render ms": update.renderMs,
    "document update: longest commit render ms": update.renderMsMax,
  }
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
  const rows: Record<string, number[]> = {}
  const add = (headlines: Record<string, number | null>) => {
    for (const [name, value] of Object.entries(headlines)) if (value !== null) (rows[name] ??= []).push(value)
  }
  for (const start of records.flatMap((record) => record.cold as Cold[]))
    add({
      "cold start: launch to JS runtime ms": start.launchToRuntimeMs,
      "cold start: bundle evaluation ms": start.bundleMs,
      "cold start: launch to first commit ms": start.launchToFirstCommitMs,
      "cold start: launch to thread list ms": start.launchToThreadListMs,
    })
  for (const entry of records.flatMap((record) => record.rounds as Entry[])) add(headline(entry))
  for (const entry of records.flatMap((record) => (record.documents ?? []) as DocumentOpen[]))
    add(documentOpenHeadline(entry))
  for (const entry of records.flatMap((record) => (record.documentLarge ?? []) as DocumentLarge[]))
    add(documentLargeHeadline(entry))
  return {
    runs: files.length,
    load: records.map((record) => record.meta.load as { start: number[]; end: number[] }),
    values: Object.fromEntries(
      Object.entries(rows).map(([name, values]) => [name, { median: median(values), values }]),
    ),
  }
}

const loadText = (load: { start: number[]; end: number[] }[]) =>
  load.map(({ start, end }) => `${round1(start[0]!)} to ${round1(end[0]!)}`).join(", ")

if (mode === "run" && label) await measure(label)
else if (mode === "compare" && label && other) {
  const before = metrics(label)
  const after = metrics(other)
  console.log(`${label}: ${before.runs} runs, ${other}: ${after.runs} runs`)
  console.log(`one-minute load, start to end: ${label} ${loadText(before.load)}; ${other} ${loadText(after.load)}`)
  console.log(`| Measurement | ${label} | ${other} | Change | ${label} spread | ${other} spread |`)
  console.log("| --- | ---: | ---: | ---: | --- | --- |")
  for (const [name, { median: a, values: va }] of Object.entries(before.values)) {
    const b = after.values[name]
    if (b === undefined) continue
    const change = a === 0 ? "" : `${Math.round(((b.median - a) / a) * 100)}%`
    console.log(`| ${name} | ${a} | ${b.median} | ${change} | ${spread(va)} | ${spread(b.values)} |`)
  }
} else if (mode === "summary" && label) {
  const { runs, load, values } = metrics(label)
  console.log(`${label}: ${runs} runs, one-minute load from start to end: ${loadText(load)}`)
  for (const [name, { median: value, values: all }] of Object.entries(values))
    console.log(`${name}: ${value} (${all.join(", ")})`)
} else {
  console.error("usage: mobile.ts run <label> | summary <label> | compare <before-label> <after-label>")
  process.exit(2)
}
