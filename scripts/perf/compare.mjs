#!/usr/bin/env node
// Usage: compare.mjs <before-label> <after-label>
// Prints before/after for every scenario both labels have in results/.
import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const resultsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", ".context", "perf")

const [before, after] = process.argv.slice(2)

const load = (label, scenario) => {
  const file = join(resultsDir, `${label}-${scenario}.json`)
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null
}
const row = (name, a, b, unit = "") => {
  const delta =
    typeof a === "number" && typeof b === "number"
      ? `${b - a >= 0 ? "+" : ""}${(b - a).toFixed(1)} (${((100 * (b - a)) / a).toFixed(0)}%)`
      : ""
  console.log(`${name.padEnd(34)} ${String(a).padStart(10)}${unit}  ${String(b).padStart(10)}${unit}  ${delta}`)
}
const median = (xs) => xs.toSorted((x, y) => x - y)[Math.floor(xs.length / 2)]

console.log(`${"metric".padEnd(34)} ${before.padStart(12)}  ${after.padStart(12)}  delta`)
for (const scenario of ["switch", "scroll", "settle"]) {
  const a = load(before, scenario)
  const b = load(after, scenario)
  if (!a || !b) continue
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
  if (scenario === "settle") {
    row("settle: rpc wall ms", a.settleMs, b.settleMs)
    row("settle: main blocked max ms", a.probeMaxMs, b.probeMaxMs)
  }
}
