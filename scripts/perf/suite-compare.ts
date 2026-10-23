#!/usr/bin/env node
import assert from "node:assert/strict"
import { readdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

type Renders = { commits: number; renders: number; byComponent: Record<string, number> }
type Run = {
  cpuThrottle: number
  rounds: { round: number; ms: number; work: { scriptMs: number }; renders: Renders; longTaskMs: number }[]
  heapEnd: { jsHeapUsedMB: number }
  keyToPaint: { p50: number; p95: number; max: number }
  work: { scriptMs: number }
  workload: { chars: number }
  rendersPerKey: number
  renders: Renders
  frames: { p95: number; max: number; over33: number }
  over50: number
}

const resultsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", ".context", "perf")
const [before, after] = process.argv.slice(2)
if (!before || !after) throw new Error("usage: suite-compare.ts <before-label> <after-label>")

const median = (values: number[]) => {
  const sorted = values.toSorted((a, b) => a - b)
  return +((sorted[Math.floor((sorted.length - 1) / 2)]! + sorted[Math.floor(sorted.length / 2)]!) / 2).toFixed(1)
}
const runs = (label: string, scenario: string): Run[] => {
  const pattern = new RegExp(`^${label}-\\d+-${scenario}\\.json$`)
  const files = readdirSync(resultsDir).filter((file) => pattern.test(file))
  assert(files.length > 0, `no ${scenario} runs for ${label}`)
  return files.map((file) => JSON.parse(readFileSync(join(resultsDir, file), "utf8")))
}
const rendersOf = (renders: Renders, name: string) =>
  (renders.byComponent[name] ?? 0) + (renders.byComponent[`${name} (mount)`] ?? 0)

const metrics = (label: string): Record<string, unknown> => {
  const typing = runs(label, "typing")
  const switches = runs(label, "switch")
  const replies = runs(label, "reply")
  const typingReplies = runs(label, "typing-reply")
  const throttles = new Set([...typing, ...switches, ...replies].map((run) => run.cpuThrottle))
  assert.equal(throttles.size, 1, `${label} mixes CPU throttle rates`)
  const warm = switches.flatMap((run) => run.rounds.filter((round) => round.round > 0))
  const cold = switches.flatMap((run) => run.rounds.filter((round) => round.round === 0))
  return {
    cpuThrottle: [...throttles][0],
    runs: { typing: typing.length, switch: switches.length, reply: replies.length },
    "typing: key to paint p50 ms": median(typing.map((run) => run.keyToPaint.p50)),
    "typing: key to paint p95 ms": median(typing.map((run) => run.keyToPaint.p95)),
    "typing: key to paint max ms": median(typing.map((run) => run.keyToPaint.max)),
    "typing: script ms per key": median(typing.map((run) => run.work.scriptMs / run.workload.chars)),
    "typing: component renders per key": median(typing.map((run) => run.rendersPerKey)),
    "typing: commits per key": median(typing.map((run) => run.renders.commits / run.workload.chars)),
    "switch: cold open ms": median(cold.map((round) => round.ms)),
    "switch: warm open ms": median(warm.map((round) => round.ms)),
    "switch: warm script ms": median(warm.map((round) => round.work.scriptMs)),
    "switch: warm component renders": median(warm.map((round) => round.renders.renders)),
    "switch: warm long task ms": median(warm.map((round) => round.longTaskMs)),
    "switch: heap after rounds MB": median(switches.map((run) => run.heapEnd.jsHeapUsedMB)),
    "reply: frame p95 ms": median(replies.map((run) => run.frames.p95)),
    "reply: frame max ms": median(replies.map((run) => run.frames.max)),
    "reply: frames over 33 ms": median(replies.map((run) => run.frames.over33)),
    "reply: script ms": median(replies.map((run) => run.work.scriptMs)),
    "reply: component renders": median(replies.map((run) => run.renders.renders)),
    "reply: MessageBody renders": median(replies.map((run) => rendersOf(run.renders, "MessageBody"))),
    "reply: Composer renders": median(replies.map((run) => rendersOf(run.renders, "Composer"))),
    "reply: ComposerInput renders": median(replies.map((run) => rendersOf(run.renders, "ComposerInput"))),
    "typing mid-reply: key to paint p50 ms": median(typingReplies.map((run) => run.keyToPaint.p50)),
    "typing mid-reply: key to paint p95 ms": median(typingReplies.map((run) => run.keyToPaint.p95)),
    "typing mid-reply: key to paint max ms": median(typingReplies.map((run) => run.keyToPaint.max)),
    "typing mid-reply: keys over 50 ms": median(typingReplies.map((run) => run.over50)),
  }
}

const a = metrics(before)
const b = metrics(after)
assert.equal(a.cpuThrottle, b.cpuThrottle, "labels use different CPU throttle rates")
const rows = Object.keys(a).flatMap((metric) => {
  const x = a[metric]
  const y = b[metric]
  if (typeof x !== "number" || typeof y !== "number" || metric === "cpuThrottle") return []
  return [{ metric, before: x, after: y, change: x === 0 ? null : +((100 * (y - x)) / x).toFixed(0) }]
})
console.log(`CPU throttle ${a.cpuThrottle}x, runs ${JSON.stringify(a.runs)} vs ${JSON.stringify(b.runs)}`)
console.log(`${"metric".padEnd(36)} ${before.padStart(10)} ${after.padStart(10)}  change`)
for (const row of rows) {
  const change = row.change === null ? "" : `${row.change > 0 ? "+" : ""}${row.change}%`
  console.log(
    `${row.metric.padEnd(36)} ${String(row.before).padStart(10)} ${String(row.after).padStart(10)}  ${change}`,
  )
}
writeFileSync(join(resultsDir, `${before}-${after}-suite.json`), JSON.stringify({ before, after, rows }, null, 2))
