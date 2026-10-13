import assert from "node:assert/strict"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const [beforeLabel, afterLabel, scenario = "history"] = process.argv.slice(2)
if (!beforeLabel || !afterLabel)
  throw new Error("usage: compare-memory.mjs <before-label> <after-label> [history|claude]")
const directory = join(process.cwd(), ".context/perf")
const read = (label) => JSON.parse(readFileSync(join(directory, `${label}-${scenario}-memory.json`), "utf8"))
const before = read(beforeLabel)
const after = read(afterLabel)
assert.equal(before.error, undefined, "baseline capture failed")
assert.equal(after.error, undefined, "candidate capture failed")
assert.equal(before.scenario, after.scenario)
assert.deepEqual(before.workload, after.workload, "workloads differ")
const stages =
  scenario === "history" ? ["seeded", "left-running", "completed-background", "reopened-first"] : ["idle-70s"]
const comparison = stages.map((name) => {
  const a = before.samples.find((sample) => sample.name === name)
  const b = after.samples.find((sample) => sample.name === name)
  assert.ok(a && b, `missing ${name}`)
  const delta = (key) => ({
    beforeMiB: a[key] / 1048576,
    afterMiB: b[key] / 1048576,
    deltaMiB: (b[key] - a[key]) / 1048576,
    changePercent: ((b[key] - a[key]) / a[key]) * 100,
  })
  return { name, rendererHeap: delta("rendererHeapBytes"), processTreeRss: delta("rssBytes") }
})
const result = { before: beforeLabel, after: afterLabel, scenario, workload: before.workload, comparison }
writeFileSync(
  join(directory, `${beforeLabel}-${afterLabel}-${scenario}-memory-comparison.json`),
  JSON.stringify(result, null, 2),
)
console.log(JSON.stringify(result, null, 2))
