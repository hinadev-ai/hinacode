import assert from "node:assert/strict"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

type Sample = {
  name: string
  rendererHeapBytes: number
  rssBytes: number
  appRssBytes: number
  cliRssBytes: number
  main: { heapUsed: number }
}
type Capture = {
  error?: unknown
  scenario: string
  workload: { idleSeconds: number }
  samples: Sample[]
  switches: { ms: number }[]
  startup: { firstRpcMs: number }
}

const [beforeLabel, afterLabel, scenario = "history"] = process.argv.slice(2)
if (!beforeLabel || !afterLabel)
  throw new Error("usage: compare-memory.ts <before-label> <after-label> [history|claude|footprint]")
const directory = join(process.cwd(), ".context/perf")
const median = (values: number[]) => {
  const sorted = values.toSorted((a, b) => a - b)
  return (sorted[Math.floor((sorted.length - 1) / 2)]! + sorted[Math.floor(sorted.length / 2)]!) / 2
}
const read = (label: string): Capture =>
  JSON.parse(readFileSync(join(directory, `${label}-${scenario}-memory.json`), "utf8"))
const before = read(beforeLabel)
const after = read(afterLabel)
assert.equal(before.error, undefined, "baseline capture failed")
assert.equal(after.error, undefined, "candidate capture failed")
assert.equal(before.scenario, after.scenario)
assert.deepEqual(before.workload, after.workload, "workloads differ")
const stages =
  scenario === "footprint"
    ? ["empty-idle-15s", "seeded-idle-15s", `closed-idle-${before.workload.idleSeconds}s`]
    : scenario === "history"
      ? ["seeded", "left-running", "completed-background", "reopened-first"]
      : ["idle-70s"]
const comparison = stages.map((name) => {
  const a = before.samples.find((sample) => sample.name === name)
  const b = after.samples.find((sample) => sample.name === name)
  assert.ok(a && b, `missing ${name}`)
  const delta = (key: "rendererHeapBytes" | "rssBytes" | "appRssBytes" | "cliRssBytes") => ({
    beforeMiB: a[key] / 1048576,
    afterMiB: b[key] / 1048576,
    deltaMiB: (b[key] - a[key]) / 1048576,
    changePercent: ((b[key] - a[key]) / a[key]) * 100,
  })
  return {
    name,
    rendererHeap: delta("rendererHeapBytes"),
    processTreeRss: delta("rssBytes"),
    ...(scenario === "footprint"
      ? {
          appRss: delta("appRssBytes"),
          cliRss: delta("cliRssBytes"),
          mainHeap: {
            beforeMiB: a.main.heapUsed / 1048576,
            afterMiB: b.main.heapUsed / 1048576,
            deltaMiB: (b.main.heapUsed - a.main.heapUsed) / 1048576,
            changePercent: (b.main.heapUsed / a.main.heapUsed - 1) * 100,
          },
        }
      : {}),
  }
})
const result: Record<string, unknown> = {
  before: beforeLabel,
  after: afterLabel,
  scenario,
  workload: before.workload,
  comparison,
}
if (scenario === "footprint") {
  const a = median(before.switches.map((s) => s.ms))
  const b = median(after.switches.map((s) => s.ms))
  result.switchMedianMs = { before: a, after: b, delta: b - a, changePercent: (b / a - 1) * 100 }
  result.firstRpcMs = { before: before.startup.firstRpcMs, after: after.startup.firstRpcMs }
}
writeFileSync(
  join(directory, `${beforeLabel}-${afterLabel}-${scenario}-memory-comparison.json`),
  JSON.stringify(result, null, 2),
)
console.log(JSON.stringify(result, null, 2))
