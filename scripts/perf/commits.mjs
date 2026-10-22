#!/usr/bin/env node
import { readFileSync } from "node:fs"

const [file, minSize = "1"] = process.argv.slice(2)
if (!file) throw new Error("usage: commits.mjs <label-name.commits.json> [min-size]")
const commits = JSON.parse(readFileSync(file, "utf8"))
const start = commits[0]?.at ?? 0

const groups = new Map()
for (const commit of commits) {
  if (commit.rendered.length < Number(minSize)) continue
  const counts = new Map()
  for (const name of commit.rendered) counts.set(name, (counts.get(name) ?? 0) + 1)
  const key = [...counts]
    .toSorted((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([name, count]) => (count > 1 ? `${name}×${count}` : name))
    .join(", ")
  const group = groups.get(key) ?? { size: commit.rendered.length, at: [] }
  group.at.push(Math.round(commit.at - start))
  groups.set(key, group)
}

const total = commits.reduce((sum, commit) => sum + commit.rendered.length, 0)
console.log(`${commits.length} commits, ${total} component renders`)
for (const [key, { size, at }] of [...groups].toSorted(
  (a, b) => b[1].size * b[1].at.length - a[1].size * a[1].at.length,
)) {
  const times = at.length > 6 ? `${at.slice(0, 6).join(", ")}, …` : at.join(", ")
  console.log(`\n${at.length} × ${size} renders at ${times} ms\n  ${key}`)
}
