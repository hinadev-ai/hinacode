#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { WebSocket, type MessageEvent } from "ws"

type Target = { type: string; url: string; webSocketDebuggerUrl: string }
type Reply = { id?: number; error?: unknown; result?: unknown }
type Metric = { name: string; value: number }
type Counter =
  | "TaskDuration"
  | "ScriptDuration"
  | "RecalcStyleDuration"
  | "LayoutDuration"
  | "RecalcStyleCount"
  | "LayoutCount"
type Counters = Record<Counter, number>
type Commit = { rendered: string[] }
type LongTask = { start: number; duration: number }
type Key = { start: number; streaming: boolean; toFrame: number; toPaint: number }
type OpenThread = { ms: number; articles: number; longTasks: LongTask[] }
type ScrollRun = Record<string, unknown> & { longTasks: LongTask[] }

const resultsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", ".context", "perf")

const [port, label, scenario, ...args] = process.argv.slice(2)
if (!port || !label || !scenario) {
  console.error("usage: measure.ts <cdp-port> <label> <scenario> [args...]")
  process.exit(2)
}

const targets = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()) as Target[]
const page = targets.find((t) => t.type === "page" && t.url.includes("/renderer/index.html"))
if (!page) throw new Error("no hinacode renderer page")
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  ws.addEventListener("open", resolve, { once: true })
  ws.addEventListener("error", reject, { once: true })
})
let nextId = 1
const pending = new Map<number, (msg: Reply) => void>()
ws.addEventListener("message", (e) => {
  const msg: Reply = JSON.parse(e.data.toString())
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)!(msg)
    pending.delete(msg.id)
  }
})
const send = <T = unknown>(method: string, params = {}) =>
  new Promise<T>((resolve, reject) => {
    const id = nextId++
    pending.set(id, (msg) => (msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result as T)))
    ws.send(JSON.stringify({ id, method, params }))
  })
const evaluate = async <T = unknown>(expression: string): Promise<T> => {
  const r = await send<{ exceptionDetails?: unknown; result: { value: T } }>("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  })
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails))
  return r.result.value
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const waitFor = async (expression: string, timeoutMs = 20000) => {
  const deadline = Date.now() + timeoutMs
  while (!(await evaluate(expression).catch(() => false))) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${expression}`)
    await sleep(50)
  }
}

await send("Performance.enable")
await send("Emulation.setDeviceMetricsOverride", {
  width: 1280,
  height: 820,
  deviceScaleFactor: 1,
  mobile: false,
})
await send("HeapProfiler.enable")
await send("Page.enable")
await send("Page.addScriptToEvaluateOnNewDocument", {
  source: readFileSync(join(dirname(fileURLToPath(import.meta.url)), "react-commits.js"), "utf8"),
})
await evaluate('localStorage.setItem("hinacode.location", "/")')
await send("Page.reload")
const cpuThrottle = Number(process.env.CPU_THROTTLE ?? 1)
await send("Emulation.setCPUThrottlingRate", { rate: cpuThrottle })
await waitFor(`"__reactCommits" in window && document.querySelector('a[href^="/thread/"]') !== null`)

const counters = async () => {
  const { metrics } = await send<{ metrics: Metric[] }>("Performance.getMetrics")
  return Object.fromEntries(metrics.map((metric) => [metric.name, metric.value])) as Counters
}
const seconds = (before: Counters, after: Counters, name: Counter) => +((after[name] - before[name]) * 1000).toFixed(1)
const workBetween = (before: Counters, after: Counters) => ({
  taskMs: seconds(before, after, "TaskDuration"),
  scriptMs: seconds(before, after, "ScriptDuration"),
  styleMs: seconds(before, after, "RecalcStyleDuration"),
  layoutMs: seconds(before, after, "LayoutDuration"),
  styleRecalcs: after.RecalcStyleCount - before.RecalcStyleCount,
  layouts: after.LayoutCount - before.LayoutCount,
})
const summarizeCommits = (commits: Commit[]) => {
  const counts = new Map<string, number>()
  for (const { rendered } of commits) for (const name of rendered) counts.set(name, (counts.get(name) ?? 0) + 1)
  return {
    commits: commits.length,
    renders: commits.reduce((total, commit) => total + commit.rendered.length, 0),
    largestCommits: commits
      .map((commit) => commit.rendered.length)
      .toSorted((a, b) => b - a)
      .slice(0, 10),
    byComponent: Object.fromEntries([...counts].toSorted((a, b) => b[1] - a[1])),
  }
}
const startTrace = async () => {
  const events: unknown[] = []
  const collect = (e: MessageEvent) => {
    const msg: { method?: string; params: { value: unknown[] } } = JSON.parse(e.data.toString())
    if (msg.method === "Tracing.dataCollected") events.push(...msg.params.value)
  }
  ws.addEventListener("message", collect)
  await send("Tracing.start", {
    categories: [
      "devtools.timeline",
      "disabled-by-default-devtools.timeline",
      "disabled-by-default-devtools.timeline.frame",
      "disabled-by-default-v8.cpu_profiler",
      "v8.execute",
      "blink.user_timing",
      "latencyInfo",
    ].join(","),
    transferMode: "ReportEvents",
  })
  return async (file: string) => {
    const complete = new Promise<void>((resolve) => {
      const done = (e: MessageEvent) => {
        if (JSON.parse(e.data.toString()).method !== "Tracing.tracingComplete") return
        ws.removeEventListener("message", done)
        resolve()
      }
      ws.addEventListener("message", done)
    })
    await send("Tracing.end")
    await complete
    ws.removeEventListener("message", collect)
    writeFileSync(file, JSON.stringify({ traceEvents: events }))
  }
}
const record = async <T>(name: string, action: () => Promise<T>) => {
  const before = await counters()
  const saveTrace = process.env.TRACE === "1" ? await startTrace() : null
  if (process.env.PROFILE === "1") {
    await send("Profiler.enable")
    await send("Profiler.setSamplingInterval", { interval: 200 })
    await send("Profiler.start")
  }
  await evaluate("window.__reactCommits.start()")
  const result = await action()
  const commits = await evaluate<Commit[]>("window.__reactCommits.stop()")
  const after = await counters()
  mkdirSync(resultsDir, { recursive: true })
  if (process.env.PROFILE === "1") {
    const { profile } = await send<{ profile: unknown }>("Profiler.stop")
    writeFileSync(join(resultsDir, `${label}-${name}.cpuprofile`), JSON.stringify(profile))
  }
  if (saveTrace) await saveTrace(join(resultsDir, `${label}-${name}.trace.json`))
  writeFileSync(join(resultsDir, `${label}-${name}.commits.json`), JSON.stringify(commits))
  return { result, work: workBetween(before, after), renders: summarizeCommits(commits) }
}
const press = async (key: string, code: string, keyCode: number, modifiers = 0) => {
  for (const type of ["keyDown", "keyUp"]) {
    await send("Input.dispatchKeyEvent", { type, key, code, windowsVirtualKeyCode: keyCode, modifiers })
  }
}
const longTaskMs = async (since: number) => {
  const tasks = await evaluate<LongTask[]>(`window.__perf.takeLongTasks(${since})`)
  return Math.round(tasks.reduce((total, task) => total + task.duration, 0))
}
const TYPED_TEXT = "Profile the composer so that every keystroke paints within one frame, even on long threads."
const KEY_INTERVAL_MS = 50
const COMPOSER = `document.querySelector('main textarea[role="combobox"]')`
const STATUS = `document.querySelector("main header [data-status]").dataset.status`
const typeText = async (text: string) => {
  for (const char of text) {
    await send("Input.dispatchKeyEvent", { type: "keyDown", key: char, text: char, unmodifiedText: char })
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: char })
    await sleep(KEY_INTERVAL_MS)
  }
}
const clearComposer = async () => {
  const typed = await evaluate(`${COMPOSER}.value`)
  if (typed !== TYPED_TEXT) throw new Error(`composer holds ${JSON.stringify(typed)}`)
  const CTRL = 2
  await press("a", "KeyA", 65, CTRL)
  await press("Backspace", "Backspace", 8)
}
const settleTranscript = async () => {
  const snapshot = `JSON.stringify([window.__perf.scroller()?.scrollTop, [...document.querySelectorAll("main article")].map((article) => article.dataset.messageId)])`
  let previous = await evaluate(snapshot)
  let stableSince = Date.now()
  const deadline = Date.now() + 15000
  while (Date.now() - stableSince < 1000) {
    if (Date.now() > deadline) throw new Error("the transcript kept changing after opening")
    await sleep(100)
    const current = await evaluate(snapshot)
    if (current !== previous) stableSince = Date.now()
    previous = current
  }
}
const assertReplied = async () => {
  const replied = await evaluate(`(() => {
    const last = [...document.querySelectorAll("main article")].at(-1)
    return document.querySelector('main article[aria-busy="true"]') === null &&
      (last?.textContent.includes("A second paragraph, to show the gap between paragraphs.") ?? false)
  })()`)
  if (!replied) throw new Error("the reply did not finish with the stream fixture")
}
const percentiles = (values: number[]) => {
  const sorted = values.toSorted((a, b) => a - b)
  const at = (q: number) => +(sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0).toFixed(1)
  return { count: sorted.length, p50: at(0.5), p95: at(0.95), max: at(1) }
}
const heap = async () => {
  await send("HeapProfiler.collectGarbage")
  await new Promise((r) => setTimeout(r, 300))
  const { metrics } = await send<{ metrics: Metric[] }>("Performance.getMetrics")
  const get = (name: string) => metrics.find((m) => m.name === name)?.value
  return {
    jsHeapUsedMB: +(get("JSHeapUsedSize")! / 1048576).toFixed(1),
    nodes: get("Nodes"),
    listeners: get("JSEventListeners"),
  }
}

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
  const keys = []
  document.addEventListener("keydown", (event) => {
    const start = event.timeStamp
    const streaming = document.querySelector('main article[aria-busy="true"]') !== null
    requestAnimationFrame(() => {
      const frameAt = performance.now()
      const channel = new MessageChannel()
      channel.port1.onmessage = () => keys.push({ start, streaming, toFrame: frameAt - start, toPaint: performance.now() - start })
      channel.port2.postMessage(null)
    })
  }, true)
  let frames = null
  window.__perf = { lt, frame, scroller,
    takeLongTasks(since) { return lt.filter((t) => t.start >= since) },
    takeKeys(since) { return keys.filter((k) => k.start >= since) },
    startFrames() {
      frames = []
      let previous = performance.now()
      const loop = (now) => {
        if (frames === null) return
        frames.push(now - previous)
        previous = now
        requestAnimationFrame(loop)
      }
      requestAnimationFrame(loop)
    },
    stopFrames() {
      const gaps = frames
      frames = null
      return gaps
    },
    async openThread(id) {
      const link = document.querySelector('a[href="/thread/' + id + '"]')
      if (!link) throw new Error("no sidebar link for " + id)
      const t0 = performance.now()
      link.click()
      // painted = the transcript is visible (LegendList holds it at opacity 0 until its first layout) and two frames kept the same article count
      let last = -1, stable = 0
      while (stable < 2) {
        await frame()
        const articles = document.querySelectorAll("main article")
        const n = articles.length
        const shown = n > 0 && articles[n - 1].checkVisibility({ opacityProperty: true })
        if (shown && n === last) stable++; else stable = 0
        last = n
        if (performance.now() - t0 > 20000) throw new Error("timeout opening " + id + ": " + JSON.stringify({ articles: n, shown: document.querySelector("main")?.innerText.slice(0, 200) }))
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

const results: Record<string, unknown> = {
  label,
  scenario,
  args,
  cpuThrottle,
  viewport: await evaluate("({width: innerWidth, height: innerHeight, devicePixelRatio})"),
  at: new Date().toISOString(),
}
if (scenario === "switch") {
  results.heapStart = await heap()
  const rounds: unknown[] = []
  results.rounds = rounds
  for (let round = 0; round < 3; round++) {
    for (const id of args) {
      const {
        result: r,
        work,
        renders,
      } = await record(`switch-${round}-${id.slice(0, 8)}`, () =>
        evaluate<OpenThread>(`window.__perf.openThread(${JSON.stringify(id)})`),
      )
      rounds.push({
        round,
        id,
        ms: +r.ms.toFixed(1),
        articles: r.articles,
        longTaskMs: +r.longTasks.reduce((a, t) => a + t.duration, 0).toFixed(0),
        work,
        renders,
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
  const run = await evaluate<ScrollRun>(`window.__perf.scrollRun(${args[1] ?? 600})`)
  if (profile) {
    const { profile: data } = await send<{ profile: unknown }>("Profiler.stop")
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
  const r = await evaluate<{ ms: number; probes: number[]; envelope: unknown }>(`(async () => {
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
} else if (scenario === "typing") {
  await evaluate(`window.__perf.openThread(${JSON.stringify(args[0])})`)
  await sleep(500)
  await evaluate(`${COMPOSER}.focus()`)
  const since = await evaluate<number>("performance.now()")
  const {
    result: keys,
    work,
    renders,
  } = await record("typing", async () => {
    await typeText(TYPED_TEXT)
    await sleep(300)
    return evaluate<Key[]>(`window.__perf.takeKeys(${since})`)
  })
  await clearComposer()
  results.workload = { chars: TYPED_TEXT.length, keyIntervalMs: KEY_INTERVAL_MS }
  results.keyToPaint = percentiles(keys.map((key) => key.toPaint))
  results.keyToFrame = percentiles(keys.map((key) => key.toFrame))
  results.work = work
  results.rendersPerKey = +(renders.renders / TYPED_TEXT.length).toFixed(1)
  results.renders = renders
  results.longTaskMs = await longTaskMs(since)
} else if (scenario === "find") {
  await evaluate(`window.__perf.openThread(${JSON.stringify(args[0])})`)
  await settleTranscript()
  await press("f", "KeyF", 70, 2)
  const input = `document.querySelector('input[aria-label="Find in thread"]')`
  await waitFor(`${input} !== null`)
  const queries = Array.from({ length: 12 }, (_, index) => `qzx${"z".repeat(index)}`)
  const since = await evaluate<number>("performance.now()")
  const { work, renders } = await record("find", async () => {
    for (const query of queries) {
      await evaluate(`${input}.focus()`)
      await press("a", "KeyA", 65, 2)
      await send("Input.insertText", { text: query })
      await evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))")
      await waitFor(`document.querySelector('search output')?.getAttribute('aria-busy') === 'false'`)
      if (!(await evaluate(`document.querySelector('search output')?.textContent === 'No results'`)))
        throw new Error("expected a settled no-match query")
    }
  })
  results.workload = { queries }
  results.work = work
  results.renders = renders
  results.longTaskMs = await longTaskMs(since)
  await press("Escape", "Escape", 27)
} else if (scenario === "typing-reply") {
  await evaluate(`window.__perf.openThread(${JSON.stringify(args[0])})`)
  await settleTranscript()
  await evaluate(`${COMPOSER}.focus()`)
  await send("Input.insertText", { text: "go" })
  const since = await evaluate<number>("performance.now()")
  const { result: keys, work } = await record("typing-reply", async () => {
    await press("Enter", "Enter", 13)
    await waitFor(`${STATUS} === "running"`)
    const typingSince = await evaluate<number>("performance.now()")
    await typeText(TYPED_TEXT)
    await waitFor(`${STATUS} === "idle"`, 60000)
    await sleep(300)
    return evaluate<Key[]>(`window.__perf.takeKeys(${typingSince})`)
  })
  await assertReplied()
  await clearComposer()
  const streamed = keys.filter((key) => key.streaming)
  if (streamed.length < 20) throw new Error(`only ${streamed.length} keys landed while the reply streamed`)
  results.workload = { chars: TYPED_TEXT.length, keyIntervalMs: KEY_INTERVAL_MS }
  results.keyToPaint = percentiles(streamed.map((key) => key.toPaint))
  results.over50 = streamed.filter((key) => key.toPaint > 50).length
  results.work = work
  results.longTaskMs = await longTaskMs(since)
} else if (scenario === "reply") {
  await evaluate(`window.__perf.openThread(${JSON.stringify(args[0])})`)
  await settleTranscript()
  const articlesBefore = await evaluate(`document.querySelectorAll("main article").length`)
  await evaluate(`${COMPOSER}.focus()`)
  await send("Input.insertText", { text: "go" })
  const since = await evaluate<number>("performance.now()")
  const {
    result: gaps,
    work,
    renders,
  } = await record("reply", async () => {
    await evaluate("window.__perf.startFrames()")
    await press("Enter", "Enter", 13)
    await waitFor(`${STATUS} === "running"`)
    await waitFor(`${STATUS} === "idle"`, 60000)
    await sleep(500)
    return evaluate<number[]>("window.__perf.stopFrames()")
  })
  await assertReplied()
  const frames = percentiles(gaps)
  results.frames = {
    ...frames,
    over33: gaps.filter((gap) => gap > 33).length,
    over50: gaps.filter((gap) => gap > 50).length,
  }
  results.work = work
  results.renders = renders
  results.articlesBefore = articlesBefore
  results.longTaskMs = await longTaskMs(since)
} else {
  throw new Error("unknown scenario " + scenario)
}

mkdirSync(resultsDir, { recursive: true })
const file = join(resultsDir, `${label}-${scenario}.json`)
writeFileSync(file, JSON.stringify(results, null, 2))
console.log(JSON.stringify(results, null, 2))
console.log(file)
await send("Emulation.setCPUThrottlingRate", { rate: 1 })
ws.terminate()
