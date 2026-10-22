#!/usr/bin/env node
import { readFileSync } from "node:fs"

const [file] = process.argv.slice(2)
if (!file) throw new Error("usage: trace-summary.mjs <label-name.trace.json>")
const { traceEvents } = JSON.parse(readFileSync(file, "utf8"))

const threadName = new Map()
for (const event of traceEvents) {
  if (event.ph === "M" && event.name === "thread_name") threadName.set(`${event.pid}:${event.tid}`, event.args.name)
}
const main = traceEvents.filter((event) => threadName.get(`${event.pid}:${event.tid}`) === "CrRendererMain")
const tracked = [
  "RunTask",
  "FunctionCall",
  "TimerFire",
  "EventDispatch",
  "UpdateLayoutTree",
  "Layout",
  "PrePaint",
  "Paint",
  "Layerize",
  "Commit",
  "HitTest",
  "ParseAuthorStyleSheet",
]

const totals = new Map()
for (const event of main.filter((candidate) => candidate.ph === "X").toSorted((a, b) => a.ts - b.ts)) {
  if (!tracked.includes(event.name)) continue
  const total = totals.get(event.name) ?? { count: 0, ms: 0, end: 0 }
  if (event.ts < total.end) continue
  total.count++
  total.ms += event.dur / 1000
  total.end = event.ts + event.dur
  totals.set(event.name, total)
}
const span = main.filter((event) => event.ts > 0).map((event) => event.ts)
console.log(`renderer main thread, ${((Math.max(...span) - Math.min(...span)) / 1000).toFixed(0)} ms traced`)
for (const name of tracked) {
  const total = totals.get(name)
  if (total)
    console.log(`${name.padEnd(22)} ${String(total.count).padStart(6)} × ${total.ms.toFixed(1).padStart(8)} ms`)
}

const biggest = (name, describe) => {
  const events = main.filter((event) => event.ph === "X" && event.name === name).toSorted((a, b) => b.dur - a.dur)
  console.log(`\nlargest ${name}`)
  for (const event of events.slice(0, 5))
    console.log(`  ${(event.dur / 1000).toFixed(1).padStart(7)} ms  ${describe(event)}`)
}
biggest("Layout", (event) => {
  const data = event.args?.beginData ?? {}
  return `dirty ${data.dirtyObjects ?? "?"} of ${data.totalObjects ?? "?"} objects`
})
biggest("UpdateLayoutTree", (event) => `${event.args?.elementCount ?? "?"} elements`)
biggest("Paint", (event) => {
  const clip = event.args?.data?.clip
  const area = clip ? Math.round(Math.abs((clip[2] - clip[0]) * (clip[5] - clip[1]))) : "?"
  return `node ${event.args?.data?.nodeId ?? "?"} area ${area} px²`
})
