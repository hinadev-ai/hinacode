#!/usr/bin/env node
// Usage: compare.ts <before-label> <after-label>
// Prints before/after for every scenario both labels have in .context/perf/.
import assert from "node:assert/strict"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

type Frames = {
  samples: number
  avg: number
  p95: number
  max: number
  over33: number
  over50: number
  visibility: string
  hidden: boolean
}
type Capture = {
  rounds: { ms: number }[]
  heapStart: { jsHeapUsedMB: number }
  heapEnd: { jsHeapUsedMB: number }
  run: { avg: number; p95: number; over50: number; longTaskMs: number }
  archiveMs: number
  probeMaxMs: number
  workload: { sha256: string; deltas: number } & Record<string, unknown>
  history: { sha256: string }
  viewport: unknown
  profileEnabled: boolean
  parseEnabled: boolean
  instrumented: boolean
  instrumentation: unknown
  domSha256: string
  idle: Frames
  stream: Frames
  raw: { visibility: string; hidden: boolean; dom: { busy: string }; events: unknown[] }
  timing: { deltas: number; emitMs: number }
  parsing: { count: number; totalMs: number; chars: number; maxMs: number }
  longTaskMs: number
}

const resultsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", ".context", "perf")

const [before, after] = process.argv.slice(2)
if (!before || !after || ![before, after].every((label) => /^[\w-]+$/.test(label))) {
  throw new Error("usage: compare.ts <before-label> <after-label>")
}

const load = (label: string, scenario: string): Capture | null => {
  const file = join(resultsDir, `${label}-${scenario}.json`)
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null
}
const row = (name: string, a: unknown, b: unknown, unit = "") => {
  const delta =
    typeof a === "number" && typeof b === "number"
      ? `${b - a >= 0 ? "+" : ""}${(b - a).toFixed(1)}${a === 0 ? "" : ` (${((100 * (b - a)) / a).toFixed(0)}%)`}`
      : ""
  console.log(`${name.padEnd(34)} ${String(a).padStart(10)}${unit}  ${String(b).padStart(10)}${unit}  ${delta}`)
}
const median = (xs: number[]) => xs.toSorted((x, y) => x - y)[Math.floor(xs.length / 2)]

console.log(`${"metric".padEnd(34)} ${before.padStart(12)}  ${after.padStart(12)}  delta`)
let matched = 0
for (const scenario of ["switch", "scroll", "archive", "stream"]) {
  const a = load(before, scenario)
  const b = load(after, scenario)
  if (!a || !b) continue
  matched++
  if (scenario === "switch") {
    row("switch: median open ms", median(a.rounds.map((r) => r.ms)), median(b.rounds.map((r) => r.ms)))
    row(
      "switch: first-open ms (heaviest)",
      Math.max(...a.rounds.map((r) => r.ms)),
      Math.max(...b.rounds.map((r) => r.ms)),
    )
    row("switch: JS heap after rounds MB", a.heapEnd.jsHeapUsedMB, b.heapEnd.jsHeapUsedMB)
    row(
      "switch: heap growth MB",
      +(a.heapEnd.jsHeapUsedMB - a.heapStart.jsHeapUsedMB).toFixed(1),
      +(b.heapEnd.jsHeapUsedMB - b.heapStart.jsHeapUsedMB).toFixed(1),
    )
  }
  if (scenario === "scroll") {
    row("scroll: avg frame ms", +a.run.avg.toFixed(1), +b.run.avg.toFixed(1))
    row("scroll: p95 frame ms", +a.run.p95.toFixed(1), +b.run.p95.toFixed(1))
    row("scroll: frames over 50ms", a.run.over50, b.run.over50)
    row("scroll: long task ms", a.run.longTaskMs, b.run.longTaskMs)
  }
  if (scenario === "archive") {
    row("archive: rpc wall ms", a.archiveMs, b.archiveMs)
    row("archive: main blocked max ms", a.probeMaxMs, b.probeMaxMs)
  }
  if (scenario === "stream") {
    for (const key of ["sha256", "chars", "deltas", "charsPerDelta", "intervalMs", "settlingMs"]) {
      assert.equal(a.workload[key], b.workload[key], `stream workload differs: ${key}`)
    }
    assert.equal(a.history.sha256, b.history.sha256, "persisted transcripts differ")
    assert.deepEqual(a.viewport, b.viewport, "renderer viewports differ")
    assert.equal(a.profileEnabled, b.profileEnabled, "Profiler overhead differs")
    assert.equal(a.parseEnabled, b.parseEnabled, "parser instrumentation overhead differs")
    assert.equal(a.instrumented, b.instrumented, "loaded bundle instrumentation differs")
    assert.equal(a.domSha256, b.domSha256, "final rendered text differs")
    for (const run of [a, b]) {
      assert(run.idle.samples >= 30 && run.stream.samples >= 30, "insufficient frame samples")
      assert.equal(run.idle.visibility, "visible")
      assert.equal(run.idle.hidden, false)
      assert.equal(run.raw.visibility, "visible")
      assert.equal(run.raw.hidden, false)
      assert.equal(run.timing.deltas, run.workload.deltas)
      assert.equal(run.raw.dom.busy, "false", "final message is unfinished")
      assert.equal(run.raw.events.length, run.workload.deltas + 2, "incomplete event evidence")
      if (run.parseEnabled) assert(run.instrumentation && run.parsing?.count > 0, "missing parse evidence")
    }
    const metrics: [string, number, number][] = [
      ["idle: p95 frame ms", a.idle.p95, b.idle.p95],
      ["stream: sampled frames", a.stream.samples, b.stream.samples],
      ["stream: avg frame ms", a.stream.avg, b.stream.avg],
      ["stream: p95 frame ms", a.stream.p95, b.stream.p95],
      ["stream: max frame ms", a.stream.max, b.stream.max],
      ["stream: frames over 33ms", a.stream.over33, b.stream.over33],
      ["stream: frames over 50ms", a.stream.over50, b.stream.over50],
      ["stream: long task ms", a.longTaskMs, b.longTaskMs],
      ["stream: main emit ms", a.timing.emitMs, b.timing.emitMs],
    ]
    if (a.parseEnabled) {
      metrics.push(
        ["stream: parse calls", a.parsing.count, b.parsing.count],
        ["stream: parse total ms", a.parsing.totalMs, b.parsing.totalMs],
        ["stream: parsed chars", a.parsing.chars, b.parsing.chars],
        ["stream: parse max ms", a.parsing.maxMs, b.parsing.maxMs],
      )
    }
    for (const [name, x, y] of metrics) row(name, x, y)
    const comparison = metrics.map(([metric, x, y]) => ({
      metric,
      before: x,
      after: y,
      delta: y - x,
      percent: x === 0 ? null : (100 * (y - x)) / x,
    }))
    writeFileSync(
      join(resultsDir, `${before}-${after}-stream-comparison.json`),
      JSON.stringify({ before, after, workloadSha256: a.workload.sha256, comparison }, null, 2),
    )
  }
}
assert(matched > 0, "no shared measurements for these labels")
