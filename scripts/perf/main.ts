#!/usr/bin/env node
import { type ChildProcess, spawn } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { fileURLToPath } from "node:url"
import { WebSocket } from "ws"

type Span = {
  id: string
  parent?: string
  name: string
  startMs: number
  ms: number
  query?: string
  command?: string
}
type Work = {
  rpc: Record<string, number>
  queries: number
  queryMs: number
  rpcQueries: number
  rpcQueryMs: number
  slowestQuery: { ms: number; query: string } | null
  git: number
  gh: number
}
type Open = { id: string; round: number; ms: number } & Work
type Startup = { rendererMs: number; rpcMs: number; sidebarMs: number } & Work
type Report = {
  label: string
  at: string
  threads: ReadonlyArray<{ id: string; title: string; messages: number; kb: number }>
  startups: ReadonlyArray<Startup>
  opens: ReadonlyArray<Open>
  idle: { seconds: number } & Work
}

const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..")
const resultsDir = join(repo, ".context", "perf")
const electron = createRequire(import.meta.url)("electron") as string
const runs = Number(process.env["RUNS"] ?? 5)
const idleSeconds = Number(process.env["IDLE_SECONDS"] ?? 120)
const port = Number(process.env["PORT"] ?? 9290)
const switchRounds = 3

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const median = (values: ReadonlyArray<number>) => {
  const sorted = values.toSorted((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)] ?? 0
}
const round = (value: number) => Math.round(value * 10) / 10

const readSpans = (file: string): Array<Span> =>
  existsSync(file)
    ? readFileSync(file, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Span)
    : []

const underRpc = (spans: ReadonlyArray<Span>) => {
  const byId = new Map(spans.map((span) => [span.id, span]))
  return (span: Span) => {
    for (
      let current: Span | undefined = span;
      current;
      current = current.parent ? byId.get(current.parent) : undefined
    ) {
      if (current.name.startsWith("rpc ")) return true
    }
    return false
  }
}

const sumMs = (spans: ReadonlyArray<Span>) => round(spans.reduce((total, span) => total + span.ms, 0))

const workBetween = (spans: ReadonlyArray<Span>, from: number, to: number): Work => {
  const inside = spans.filter((span) => span.startMs >= from && span.startMs <= to)
  const queries = inside.filter((span) => span.query !== undefined)
  const rpcQueries = queries.filter(underRpc(spans))
  const slowest = queries.toSorted((a, b) => b.ms - a.ms)[0]
  const rpc: Record<string, number> = {}
  for (const span of inside.filter((candidate) => candidate.name.startsWith("rpc "))) {
    const method = span.name.slice("rpc ".length)
    rpc[method] = (rpc[method] ?? 0) + 1
  }
  return {
    rpc,
    queries: queries.length,
    queryMs: sumMs(queries),
    rpcQueries: rpcQueries.length,
    rpcQueryMs: sumMs(rpcQueries),
    slowestQuery: slowest ? { ms: round(slowest.ms), query: slowest.query! } : null,
    git: inside.filter((span) => span.name === "exec git").length,
    gh: inside.filter((span) => span.name === "exec gh").length,
  }
}

const connect = async (deadline: number) => {
  let page: { webSocketDebuggerUrl: string } | undefined
  while (!page) {
    if (Date.now() > deadline) throw new Error(`no renderer on CDP port ${port}`)
    const targets = await fetch(`http://127.0.0.1:${port}/json`)
      .then(
        (response) => response.json() as Promise<Array<{ type: string; url: string; webSocketDebuggerUrl: string }>>,
      )
      .catch(() => [])
    page = targets.find((target) => target.type === "page" && target.url.includes("/renderer/index.html"))
    if (!page) await sleep(10)
  }
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true })
    ws.addEventListener("error", reject, { once: true })
  })
  let nextId = 1
  const pending = new Map<number, (reply: { error?: unknown; result?: unknown }) => void>()
  ws.addEventListener("message", (event) => {
    const reply = JSON.parse(event.data.toString())
    pending.get(reply.id)?.(reply)
    pending.delete(reply.id)
  })

  const evaluate = <T>(expression: string) =>
    new Promise<T>((resolve, reject) => {
      const id = nextId++
      pending.set(id, (reply) => {
        const result = reply.result as { result?: { value: T }; exceptionDetails?: unknown } | undefined
        if (reply.error || result?.exceptionDetails) reject(new Error(JSON.stringify(reply.error ?? result)))
        else resolve(result!.result!.value)
      })
      ws.send(
        JSON.stringify({
          id,
          method: "Runtime.evaluate",
          params: { expression, awaitPromise: true, returnByValue: true },
        }),
      )
    })

  const waitFor = async (expression: string, until: number) => {
    while (!(await evaluate<boolean>(expression).catch(() => false))) {
      if (Date.now() > until) throw new Error(`timed out waiting for ${expression}`)
      await sleep(10)
    }
  }

  return { evaluate, waitFor, close: () => ws.close() }
}

const launch = (data: string, trace: string) =>
  spawn(
    electron,
    ["--no-sandbox", "--disable-gpu", `--remote-debugging-port=${port}`, join(repo, "out", "main", "index.js")],
    {
      cwd: repo,
      detached: true,
      stdio: ["ignore", "ignore", "ignore"],
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter(
            ([key]) => key !== "WAYLAND_DISPLAY" && key !== "ELECTRON_OZONE_PLATFORM_HINT",
          ),
        ),
        XDG_SESSION_TYPE: "x11",
        DISPLAY: process.env["DISPLAY_FOR_PERF"] ?? ":99",
        HINACODE_USER_DATA: data,
        HINACODE_TRACE: trace,
        HINACODE_MOCK_CLAUDE: process.env["HINACODE_MOCK_CLAUDE"] ?? "stream",
      },
    },
  )

const signalGroup = (pid: number, signal: NodeJS.Signals) => {
  try {
    process.kill(-pid, signal)
  } catch {
    return
  }
}

const stop = async (child: ChildProcess) => {
  if (child.pid === undefined || child.exitCode !== null) return
  const exited = new Promise((resolve) => child.once("exit", resolve))
  signalGroup(child.pid, "SIGTERM")
  await Promise.race([exited, sleep(5000)])
  signalGroup(child.pid, "SIGKILL")
}

const openThread = (id: string) => `(async () => {
  const link = document.querySelector('a[href="/thread/${id}"]')
  if (!link) throw new Error("no sidebar link for ${id}")
  const frame = () => new Promise((resolve) => requestAnimationFrame(resolve))
  const t0 = performance.now()
  link.click()
  let last = -1, stable = 0
  while (stable < 2) {
    await frame()
    const articles = document.querySelectorAll("main article")
    const shown = articles.length > 0 && articles[articles.length - 1].checkVisibility({ opacityProperty: true })
    if (shown && articles.length === last) stable++; else stable = 0
    last = articles.length
    if (performance.now() - t0 > 30000) throw new Error("timed out opening ${id}")
  }
  return performance.now() - t0
})()`

const pickThreads = (data: string, requested: ReadonlyArray<string>) => {
  const db = new DatabaseSync(join(data, "hinacode.sqlite"), { readOnly: true })
  const rows = db
    .prepare(
      `SELECT thread.id, thread.title, count(message.id) AS messages, coalesce(sum(length(message.parts)), 0) / 1024 AS kb
       FROM thread LEFT JOIN message ON message.thread_id = thread.id
       WHERE thread.status != 'archived'
       GROUP BY thread.id HAVING messages > 0 ORDER BY kb DESC`,
    )
    .all() as Array<{ id: string; title: string; messages: number; kb: number }>
  db.close()
  if (requested.length > 0)
    return requested.map((id) => rows.find((row) => row.id === id) ?? { id, title: id, messages: 0, kb: 0 })
  return [...rows.slice(0, 2), ...rows.slice(-1)].filter((row, index, all) => all.indexOf(row) === index)
}

const measure = async (label: string, data: string, requested: ReadonlyArray<string>) => {
  if (!data.startsWith("/tmp/kk-"))
    throw new Error("the user data dir must start with /tmp/kk- so a real profile is never used")
  if (!existsSync(join(data, "hinacode.sqlite")))
    throw new Error(`${data} has no hinacode.sqlite; seed or copy one first`)
  if (!existsSync(join(repo, "out", "main", "index.js"))) throw new Error("build first: pnpm build")
  const threads = pickThreads(data, requested)
  const startups: Array<Startup> = []
  const opens: Array<Open> = []
  let idle: Report["idle"] = { seconds: 0, ...workBetween([], 0, 0) }

  for (let run = 1; run <= runs; run++) {
    const trace = join(data, `trace-${label}-${run}.jsonl`)
    rmSync(trace, { force: true })
    const startedAt = Date.now()
    const child = launch(data, trace)
    try {
      const deadline = startedAt + 60_000
      const page = await connect(deadline)
      const rendererMs = Date.now() - startedAt
      await page.waitFor(`window.hinacode.rpc("settings.get").then(() => true)`, deadline)
      const rpcMs = Date.now() - startedAt
      await page.waitFor(`document.querySelector('a[href^="/thread/"]') !== null`, deadline)
      const sidebarMs = Date.now() - startedAt
      await sleep(1000)
      startups.push({
        rendererMs,
        rpcMs,
        sidebarMs,
        ...workBetween(readSpans(trace), startedAt, startedAt + sidebarMs),
      })
      console.log(`run ${run}: sidebar after ${sidebarMs} ms`)

      if (run === runs) {
        await page.evaluate(
          `window.hinacode.rpc("settings.set", { automations: { bindHost: "127.0.0.1", port: ${40000 + port} } })`,
        )
        for (let switchRound = 0; switchRound < switchRounds; switchRound++) {
          for (const thread of threads) {
            const from = Date.now()
            const ms = await page.evaluate<number>(openThread(thread.id))
            await sleep(500)
            opens.push({
              id: thread.id,
              round: switchRound,
              ms: round(ms),
              ...workBetween(readSpans(trace), from, Date.now()),
            })
          }
        }
        console.log(`idle for ${idleSeconds} s`)
        const from = Date.now()
        await sleep(idleSeconds * 1000)
        idle = { seconds: idleSeconds, ...workBetween(readSpans(trace), from, Date.now()) }
      }
      page.close()
    } finally {
      await stop(child)
    }
  }

  const report: Report = { label, at: new Date().toISOString(), threads, startups, opens, idle }
  mkdirSync(resultsDir, { recursive: true })
  const file = join(resultsDir, `${label}-main.json`)
  writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`)
  print([report])
  console.log(`\nwrote ${file}`)
}

const summary = (report: Report) => {
  const startup = (key: keyof Startup) => median(report.startups.map((run) => run[key] as number))
  const opens = (filter: (open: Open) => boolean, key: keyof Work | "ms") =>
    median(report.opens.filter(filter).map((open) => open[key] as number))
  const perHour = (value: number) => round((value * 3600) / Math.max(report.idle.seconds, 1))
  const rows: Array<[string, number]> = [
    ["startup: renderer page up (ms)", startup("rendererMs")],
    ["startup: first rpc answered (ms)", startup("rpcMs")],
    ["startup: sidebar rendered (ms)", startup("sidebarMs")],
    ["startup: SQL queries", startup("queries")],
    ["startup: SQL time (ms)", startup("queryMs")],
    ["startup: git processes", startup("git")],
    ["startup: gh processes", startup("gh")],
  ]
  for (const thread of report.threads) {
    const label = `${thread.title.slice(0, 24)} (${thread.messages} msgs, ${thread.kb} KB)`
    const cold = (open: Open) => open.id === thread.id && open.round === 0
    const warm = (open: Open) => open.id === thread.id && open.round > 0
    rows.push(
      [`open cold: ${label} (ms)`, opens(cold, "ms")],
      [`open cold: ${label} SQL queries`, opens(cold, "rpcQueries")],
      [`open cold: ${label} SQL ms`, opens(cold, "rpcQueryMs")],
      [`open cold: ${label} git`, opens(cold, "git")],
      [`switch back: ${label} (ms)`, opens(warm, "ms")],
      [`switch back: ${label} SQL queries`, opens(warm, "rpcQueries")],
    )
  }
  rows.push(
    ["idle: SQL queries per hour", perHour(report.idle.queries)],
    ["idle: git processes per hour", perHour(report.idle.git)],
    ["idle: gh processes per hour", perHour(report.idle.gh)],
  )
  return rows
}

const print = (reports: ReadonlyArray<Report>) => {
  const tables = reports.map(summary)
  const width = Math.max(...tables[0]!.map(([name]) => name.length))
  console.log(["measurement".padEnd(width), ...reports.map((report) => report.label.padStart(12))].join("  "))
  tables[0]!.forEach(([name], row) => {
    console.log([name.padEnd(width), ...tables.map((table) => String(table[row]?.[1] ?? "").padStart(12))].join("  "))
  })
  const last = reports.at(-1)!
  const slow = last.startups.at(-1)?.slowestQuery
  if (slow) console.log(`\nslowest startup query in ${last.label}: ${slow.ms} ms ${slow.query}`)
  console.log(`rpc calls during the last startup of ${last.label}: ${JSON.stringify(last.startups.at(-1)?.rpc)}`)
}

const [command, ...rest] = process.argv.slice(2)
if (command === "compare" && rest.length >= 2) {
  print(rest.map((label) => JSON.parse(readFileSync(join(resultsDir, `${label}-main.json`), "utf8")) as Report))
} else if (command && rest[0]) {
  await measure(command, rest[0], rest.slice(1))
} else {
  console.error("usage: main.ts <label> <user-data-dir> [threadId...]\n       main.ts compare <label> <label>...")
  process.exit(2)
}
