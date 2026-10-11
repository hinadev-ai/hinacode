#!/usr/bin/env node
// Usage: analyze-profile.mjs <file.cpuprofile> [top]   Prints top functions by self time and by total (inclusive) time.
import { readFileSync } from "node:fs"
const [file, top = "25"] = process.argv.slice(2)
const p = JSON.parse(readFileSync(file, "utf8"))
const byId = new Map(p.nodes.map((n) => [n.id, n]))
const parent = new Map()
for (const n of p.nodes) for (const c of n.children ?? []) parent.set(c, n.id)
const self = new Map()
const total = new Map()
const dt = p.timeDeltas
for (let i = 0; i < p.samples.length; i++) {
  const d = dt[i] ?? 0
  let id = p.samples[i]
  self.set(id, (self.get(id) ?? 0) + d)
  const seen = new Set()
  while (id !== undefined) {
    const n = byId.get(id)
    const key = `${n.callFrame.functionName || "(anonymous)"} ${n.callFrame.url.split("/").pop()}:${n.callFrame.lineNumber}`
    if (!seen.has(key)) {
      total.set(key, (total.get(key) ?? 0) + d)
      seen.add(key)
    }
    id = parent.get(id)
  }
}
const selfByKey = new Map()
for (const [id, t] of self) {
  const n = byId.get(id)
  const key = `${n.callFrame.functionName || "(anonymous)"} ${n.callFrame.url.split("/").pop()}:${n.callFrame.lineNumber}`
  selfByKey.set(key, (selfByKey.get(key) ?? 0) + t)
}
const sum = [...self.values()].reduce((a, b) => a + b, 0)
const fmt = (m) =>
  [...m.entries()]
    .toSorted((a, b) => b[1] - a[1])
    .slice(0, +top)
    .map(([k, v]) => `${(v / 1000).toFixed(1).padStart(8)}ms ${((100 * v) / sum).toFixed(1).padStart(5)}%  ${k}`)
    .join("\n")
console.log(`total sampled ${(sum / 1000).toFixed(0)}ms\n--- self\n${fmt(selfByKey)}\n--- inclusive\n${fmt(total)}`)
