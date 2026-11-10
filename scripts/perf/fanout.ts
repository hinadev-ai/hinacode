#!/usr/bin/env node
import { execFileSync } from "node:child_process"
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { fileURLToPath } from "node:url"
import { connect, launch, median, openThread, round, sleep, stop } from "./app.ts"

type Sample = {
  mainCpuPct: number
  rendererCpuPct: number
  helperCpuPct: number
  rendererTaskMsPerS: number
  rpcP50Ms: number
  rpcP95Ms: number
  rpcMaxMs: number
  messageWrites: number
  messageWriteMs: number
  mainWrittenMB: number
}

const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..")
const resultsDir = join(repo, ".context", "perf")
const runs = Number(process.env["RUNS"] ?? 3)
const threadCount = Number(process.env["THREADS"] ?? 6)
const windowSeconds = Number(process.env["WINDOW_SECONDS"] ?? 15)
const port = Number(process.env["PORT"] ?? 9291)
const dataRoot = process.env["DATA_ROOT"] ?? "/tmp"

const processKind = (command: string) =>
  command.includes("(Renderer)") || command.includes("--type=renderer")
    ? "renderer"
    : command.includes("Helper") || command.includes("--type=")
      ? "helper"
      : "main"

const seconds = (time: string) => time.split(":").reduce((total, part) => total * 60 + Number(part), 0)

const cpuSecondsByKind = (pid: number) => {
  const totals: Record<string, number> = { main: 0, renderer: 0, helper: 0 }
  for (const line of execFileSync("ps", ["-axo", "pid=,ppid=,time=,args="], { encoding: "utf8" }).trim().split("\n")) {
    const [id, parent, time, ...args] = line.trim().split(/\s+/)
    if (id !== String(pid) && parent !== String(pid)) continue
    const kind = processKind(args.join(" "))
    totals[kind] = totals[kind]! + seconds(time!)
  }
  return totals
}

const isMessageWrite = (query: string | undefined) =>
  query !== undefined && /^(INSERT|UPDATE|DELETE)\b[^(]*\bmessage(_part)?\b/.test(query)

const bytesWritten = (pid: number) => Number(/write_bytes: (\d+)/.exec(readFileSync(`/proc/${pid}/io`, "utf8"))![1])

const run = async (label: string, clean: string, attempt: number): Promise<Sample> => {
  const data = join(dataRoot, `kk-fanout-${label}-${attempt}`)
  rmSync(data, { recursive: true, force: true })
  mkdirSync(data)
  copyFileSync(clean, join(data, "hinacode.sqlite"))
  const db = new DatabaseSync(join(data, "hinacode.sqlite"))
  db.exec("UPDATE pull_request_link SET watch = NULL; UPDATE routine SET enabled = 0, next_run_at = NULL")
  const threads = db
    .prepare(
      `SELECT id FROM thread WHERE status = 'idle' AND side_of IS NULL AND provider_session_id IS NOT NULL
       ORDER BY (SELECT count(*) FROM message WHERE thread_id = thread.id) DESC LIMIT ?`,
    )
    .all(threadCount + 1) as Array<{ id: string }>
  db.close()
  if (threads.length <= threadCount) throw new Error(`the profile needs ${threadCount + 1} started idle threads`)
  const [viewed, ...streaming] = threads.map((thread) => thread.id)

  const trace = join(data, "trace.jsonl")
  const child = launch(repo, data, port, { HINACODE_MOCK_AGENTS: "long-turn", HINACODE_TRACE: trace })
  try {
    const page = await connect(port, Date.now() + 30000)
    await page.waitFor(`document.querySelector('a[href="/thread/${viewed}"]') !== null`, Date.now() + 30000)
    await page.evaluate(openThread(viewed!))
    await page.send("Performance.enable")
    const rpc = (method: string, payload: object) =>
      page.evaluate(`window.hinacode.rpc(${JSON.stringify(method)}, ${JSON.stringify(payload)})`)
    await Promise.all(streaming.map((threadId) => rpc("threads.send", { threadId, prompt: "go" })))
    await sleep(3000)

    const taskSeconds = async () => {
      const { metrics } = await page.send<{ metrics: Array<{ name: string; value: number }> }>("Performance.getMetrics")
      return metrics.find((metric) => metric.name === "TaskDuration")!.value
    }
    const taskBefore = await taskSeconds()
    const cpuBefore = cpuSecondsByKind(child.pid!)
    const writtenBefore = bytesWritten(child.pid!)
    const startedAt = Date.now()
    const latencies = await page.evaluate<Array<number>>(`(async () => {
      const latencies = []
      const until = performance.now() + ${windowSeconds * 1000}
      while (performance.now() < until) {
        const t0 = performance.now()
        await window.hinacode.rpc("settings.get")
        latencies.push(performance.now() - t0)
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      return latencies
    })()`)
    const elapsed = (Date.now() - startedAt) / 1000
    const cpuAfter = cpuSecondsByKind(child.pid!)
    const writtenAfter = bytesWritten(child.pid!)
    const taskAfter = await taskSeconds()
    await Promise.all(streaming.map((threadId) => rpc("threads.interrupt", { threadId })))
    page.close()

    const writes = readFileSync(trace, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { startMs: number; ms: number; query?: string })
      .filter((span) => isMessageWrite(span.query) && span.startMs >= startedAt)
    const sorted = latencies.toSorted((a, b) => a - b)
    const cpuPct = (kind: string) => round(((cpuAfter[kind]! - cpuBefore[kind]!) / elapsed) * 100)
    return {
      mainCpuPct: cpuPct("main"),
      rendererCpuPct: cpuPct("renderer"),
      helperCpuPct: cpuPct("helper"),
      rendererTaskMsPerS: round(((taskAfter - taskBefore) * 1000) / elapsed),
      rpcP50Ms: round(sorted[Math.floor(sorted.length / 2)]!),
      rpcP95Ms: round(sorted[Math.floor(sorted.length * 0.95)]!),
      rpcMaxMs: round(sorted.at(-1)!),
      messageWrites: writes.length,
      messageWriteMs: round(writes.reduce((total, span) => total + span.ms, 0)),
      mainWrittenMB: round((writtenAfter - writtenBefore) / 1e6),
    }
  } finally {
    await stop(child)
  }
}

const [command, ...args] = process.argv.slice(2)
if (command === "compare") {
  const reports = args.map(
    (label) => JSON.parse(readFileSync(join(resultsDir, `${label}-fanout.json`), "utf8")) as Array<Sample>,
  )
  const keys = Object.keys(reports[0]![0]!) as Array<keyof Sample>
  console.log(["median".padEnd(22), ...args.map((label) => label.padStart(12))].join(""))
  for (const key of keys) {
    console.log(
      [
        key.padEnd(22),
        ...reports.map((samples) => String(median(samples.map((sample) => sample[key]))).padStart(12)),
      ].join(""),
    )
  }
} else if (command && args[0]) {
  const samples: Array<Sample> = []
  for (let index = 1; index <= runs; index++) {
    samples.push(await run(command, args[0], index))
    console.log(`run ${index}: ${JSON.stringify(samples.at(-1))}`)
  }
  mkdirSync(resultsDir, { recursive: true })
  writeFileSync(join(resultsDir, `${command}-fanout.json`), JSON.stringify(samples, null, 2))
} else {
  throw new Error("usage: fanout.ts <label> <profile.sqlite> | fanout.ts compare <label...>")
}
