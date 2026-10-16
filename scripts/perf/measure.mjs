#!/usr/bin/env node
// Usage: measure.mjs <cdp-port> <label> <scenario> [args...]
//   switch <threadId...>        click each sidebar thread link in turn, 3 rounds; time to painted transcript + heap
//   scroll <threadId>           open the thread, scroll bottom->top->bottom one step per frame; frame times + heap
//   archive <threadId>          turn on worktree removal, time the threads.archive rpc, and the latency of a cheap rpc while it runs
// Writes results/<label>-<scenario>.json under .context/perf/.
import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const resultsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", ".context", "perf")

const [port, label, scenario, ...args] = process.argv.slice(2)
if (!port || !label || !scenario) {
  console.error("usage: measure.mjs <cdp-port> <label> <scenario> [args...]")
  process.exit(2)
}

const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
const page = targets.find((t) => t.type === "page" && t.url.includes("/renderer/index.html"))
if (!page) throw new Error("no hinacode renderer page")
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  ws.addEventListener("open", resolve, { once: true })
  ws.addEventListener("error", reject, { once: true })
})
let nextId = 1
const pending = new Map()
ws.addEventListener("message", (e) => {
  const msg = JSON.parse(e.data)
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg)
    pending.delete(msg.id)
  }
})
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = nextId++
    pending.set(id, (msg) => (msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result)))
    ws.send(JSON.stringify({ id, method, params }))
  })
const evaluate = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails))
  return r.result.value
}

await send("Performance.enable")
await send("HeapProfiler.enable")
const heap = async () => {
  await send("HeapProfiler.collectGarbage")
  await new Promise((r) => setTimeout(r, 300))
  const { metrics } = await send("Performance.getMetrics")
  const get = (name) => metrics.find((m) => m.name === name)?.value
  return {
    jsHeapUsedMB: +(get("JSHeapUsedSize") / 1048576).toFixed(1),
    nodes: get("Nodes"),
    listeners: get("JSEventListeners"),
  }
}

// Installed once per page: long task observer + helpers the scenarios call.
await evaluate(`(() => {
  if (window.__perf) return
  const lt = []
  new PerformanceObserver((list) => { for (const e of list.getEntries()) lt.push({ start: e.startTime, duration: e.duration }) }).observe({ type: "longtask", buffered: true })
  const frame = () => new Promise((r) => requestAnimationFrame(() => r(performance.now())))
  const scroller = () => {
    const main = document.querySelector("main")
    return [...main.querySelectorAll("*")].find((el) => {
      const s = getComputedStyle(el)
      return (s.overflowY === "auto" || s.overflowY === "scroll") && el.scrollHeight > el.clientHeight + 10 && el.clientHeight > 200
    })
  }
  window.__perf = { lt, frame, scroller,
    takeLongTasks(since) { return lt.filter((t) => t.start >= since) },
    async openThread(id) {
      const link = document.querySelector('a[href="/thread/' + id + '"]')
      if (!link) throw new Error("no sidebar link for " + id)
      const t0 = performance.now()
      link.click()
      // painted = the transcript exists and two frames passed with the same article count
      let last = -1, stable = 0
      while (stable < 2) {
        await frame()
        const n = document.querySelectorAll("main article").length
        if (n > 0 && n === last) stable++; else stable = 0
        last = n
        if (performance.now() - t0 > 20000) throw new Error("timeout opening " + id)
      }
      return { ms: performance.now() - t0, articles: last, longTasks: this.takeLongTasks(t0) }
    },
    async scrollRun(step) {
      const el = scroller()
      if (!el) throw new Error("no scroll container")
      const frames = []
      const t0 = performance.now()
      let prev = await frame()
      const dir = [-1, 1]
      for (const d of dir) {
        let guard = 0
        while (guard++ < 5000) {
          const before = el.scrollTop
          el.scrollTop = before + d * step
          const now = await frame()
          frames.push(now - prev)
          prev = now
          if (el.scrollTop === before) break
        }
      }
      frames.sort((a, b) => a - b)
      const p = (q) => frames[Math.min(frames.length - 1, Math.floor(q * frames.length))]
      return { frames: frames.length, totalMs: performance.now() - t0, scrollHeight: el.scrollHeight,
        avg: frames.reduce((a, b) => a + b, 0) / frames.length, p50: p(0.5), p95: p(0.95), p99: p(0.99), max: frames.at(-1),
        over50: frames.filter((f) => f > 50).length, longTasks: this.takeLongTasks(t0), articlesMounted: document.querySelectorAll("main article").length }
    },
  }
})()`)

const results = { label, scenario, args, at: new Date().toISOString() }
if (scenario === "switch") {
  results.heapStart = await heap()
  results.rounds = []
  for (let round = 0; round < 3; round++) {
    for (const id of args) {
      const r = await evaluate(`window.__perf.openThread(${JSON.stringify(id)})`)
      results.rounds.push({
        round,
        id,
        ms: +r.ms.toFixed(1),
        articles: r.articles,
        longTaskMs: +r.longTasks.reduce((a, t) => a + t.duration, 0).toFixed(0),
      })
      await new Promise((resolve) => setTimeout(resolve, 300))
    }
  }
  results.heapEnd = await heap()
} else if (scenario === "scroll") {
  await evaluate(`window.__perf.openThread(${JSON.stringify(args[0])})`)
  await new Promise((r) => setTimeout(r, 500))
  results.heapBefore = await heap()
  const profile = process.env.PROFILE === "1"
  if (profile) {
    await send("Profiler.enable")
    await send("Profiler.setSamplingInterval", { interval: 200 })
    await send("Profiler.start")
  }
  const run = await evaluate(`window.__perf.scrollRun(${args[1] ?? 600})`)
  if (profile) {
    const { profile: data } = await send("Profiler.stop")
    mkdirSync(resultsDir, { recursive: true })
    writeFileSync(join(resultsDir, `${label}-scroll.cpuprofile`), JSON.stringify(data))
  }
  results.run = {
    ...run,
    longTaskMs: +run.longTasks.reduce((a, t) => a + t.duration, 0).toFixed(0),
    longTasks: run.longTasks.length,
  }
  results.heapAfter = await heap()
} else if (scenario === "archive") {
  const r = await evaluate(`(async () => {
    const probes = []
    const t0 = performance.now()
    await window.hinacode.rpc("settings.set", { archive: { whenMerged: false, removeWorktree: true } })
    const archive = window.hinacode.rpc("threads.archive", { threadId: ${JSON.stringify(args[0])} })
    let done = false
    archive.finally(() => { done = true })
    while (!done) {
      const p0 = performance.now()
      await window.hinacode.rpc("settings.get", undefined)
      probes.push(performance.now() - p0)
      await new Promise((r) => setTimeout(r, 100))
    }
    const envelope = await archive
    return { ms: performance.now() - t0, probes, envelope }
  })()`)
  results.archiveMs = +r.ms.toFixed(0)
  results.probeMaxMs = +Math.max(0, ...r.probes).toFixed(1)
  results.probeCount = r.probes.length
  results.envelope = r.envelope
} else {
  throw new Error("unknown scenario " + scenario)
}

mkdirSync(resultsDir, { recursive: true })
const file = join(resultsDir, `${label}-${scenario}.json`)
writeFileSync(file, JSON.stringify(results, null, 2))
console.log(JSON.stringify(results, null, 2))
console.log(file)
ws.close()
