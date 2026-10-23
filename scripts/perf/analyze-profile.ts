#!/usr/bin/env node
// Usage: analyze-profile.ts <file.cpuprofile> [top]   Prints top functions by self time and by total (inclusive) time.
import { readFileSync } from "node:fs"

type ProfileNode = {
  id: number
  children?: number[]
  callFrame: { functionName: string; url: string; lineNumber: number }
}
type Profile = { nodes: ProfileNode[]; samples: number[]; timeDeltas: number[] }

const [file, top = "25"] = process.argv.slice(2)
if (!file) throw new Error("usage: analyze-profile.ts <file.cpuprofile> [top]")
const p: Profile = JSON.parse(readFileSync(file, "utf8"))
const byId = new Map(p.nodes.map((n) => [n.id, n]))
const parent = new Map<number, number>()
for (const n of p.nodes) for (const c of n.children ?? []) parent.set(c, n.id)
const self = new Map<number, number>()
const total = new Map<string, number>()
const dt = p.timeDeltas
for (let i = 0; i < p.samples.length; i++) {
  const d = dt[i] ?? 0
  let id: number | undefined = p.samples[i]
  if (id !== undefined) self.set(id, (self.get(id) ?? 0) + d)
  const seen = new Set<string>()
  while (id !== undefined) {
    const n = byId.get(id)!
    const key = `${n.callFrame.functionName || "(anonymous)"} ${n.callFrame.url.split("/").pop()}:${n.callFrame.lineNumber}`
    if (!seen.has(key)) {
      total.set(key, (total.get(key) ?? 0) + d)
      seen.add(key)
    }
    id = parent.get(id)
  }
}
const selfByKey = new Map<string, number>()
for (const [id, t] of self) {
  const n = byId.get(id)!
  const key = `${n.callFrame.functionName || "(anonymous)"} ${n.callFrame.url.split("/").pop()}:${n.callFrame.lineNumber}`
  selfByKey.set(key, (selfByKey.get(key) ?? 0) + t)
}
const sum = [...self.values()].reduce((a, b) => a + b, 0)
const fmt = (m: Map<string, number>) =>
  [...m.entries()]
    .toSorted((a, b) => b[1] - a[1])
    .slice(0, +top)
    .map(([k, v]) => `${(v / 1000).toFixed(1).padStart(8)}ms ${((100 * v) / sum).toFixed(1).padStart(5)}%  ${k}`)
    .join("\n")
console.log(`total sampled ${(sum / 1000).toFixed(0)}ms\n--- self\n${fmt(selfByKey)}\n--- inclusive\n${fmt(total)}`)
