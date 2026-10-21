#!/usr/bin/env node
// Usage: thread-chart.mjs   Redraws the thread and worktree chart in docs/arch.md from WorktreeLifecycle.tla.
// TLC dumps every reachable state of the one-thread model, and each state is reduced to the thread's
// status and its worktree's status. Steps that change neither are left out.
import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { jar, java, root, specsDir } from "./tla-tools.mjs"

const scratch = mkdtempSync(join(tmpdir(), "tlc-chart-"))
const dot = join(scratch, "states.dot")
const tlc = spawnSync(
  java,
  [
    "-cp",
    jar,
    "tlc2.TLC",
    "-metadir",
    scratch,
    "-dump",
    "dot,actionlabels",
    dot,
    "-config",
    "WorktreeLifecycle.Liveness.cfg",
    "WorktreeLifecycle.tla",
  ],
  { cwd: specsDir, encoding: "utf8" },
)
if (!tlc.stdout.includes("No error has been found")) {
  console.error(tlc.stdout + tlc.stderr)
  process.exit(1)
}
const graph = readFileSync(dot, "utf8")
rmSync(scratch, { recursive: true, force: true })

const field = (label, name) => label.match(new RegExp(`${name} = \\(t1 :> \\\\"(\\w+)\\\\"\\)`))[1]
const nodes = new Map()
for (const [, id, label] of graph.matchAll(/^(-?\d+) \[label="(.*)"/gm)) {
  const thread = field(label, "threadStatus")
  // Before the thread row exists, the model is still creating its worktree: the chart's start.
  nodes.set(id, thread === "none" ? "[*]" : `${thread}_${field(label, "worktreeStatus")}`)
}

const edges = new Map()
for (const [, from, to, action] of graph.matchAll(/^(-?\d+) -> (-?\d+) \[label="(\w+)"/gm)) {
  const [a, b] = [nodes.get(from), nodes.get(to)]
  if (a === b) continue
  const key = `${a} --> ${b}`
  edges.set(key, (edges.get(key) ?? new Set()).add(action))
}

const states = [...new Set(nodes.values())].filter((state) => state !== "[*]").toSorted()
const chart = [
  "```mermaid",
  "stateDiagram-v2",
  "  direction LR",
  ...states.map((state) => `  state "${state.replace("_", ", worktree ")}" as ${state}`),
  ...[...edges].toSorted().map(([key, actions]) => `  ${key}: ${[...actions].toSorted().join(", ")}`),
  "```",
].join("\n")

const arch = join(root, "docs", "arch.md")
const start = "<!-- thread-chart:start -->"
const end = "<!-- thread-chart:end -->"
const doc = readFileSync(arch, "utf8")
const [before, rest] = doc.split(start)
const after = rest.slice(rest.indexOf(end))
writeFileSync(arch, `${before}${start}\n\n${chart}\n\n${after}`)
console.log(`${states.length} states, ${edges.size} transitions written to docs/arch.md`)
