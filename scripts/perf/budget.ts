#!/usr/bin/env node
import { execFileSync } from "node:child_process"
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { connect, launch, median, openThread, type Page, round, sleep, stop, transcriptShown } from "./app.ts"

type Build = "base" | "head"
type Sample = {
  startupMs: number
  startupCpuMs: number
  openMs: number
  idleCpuMsPerMinute: number
  pssMB: number
  rendererHeapMB: number
}
type Results = { runs: number; idleSeconds: number; samples: Record<Build, Array<Sample>> }

const metrics: ReadonlyArray<{ key: keyof Sample; name: string; unit: string; ratio: number; floor: number }> = [
  { key: "startupMs", name: "Launch to restored thread", unit: "ms", ratio: 1.1, floor: 75 },
  { key: "startupCpuMs", name: "CPU time until then", unit: "ms", ratio: 1.1, floor: 150 },
  { key: "openMs", name: "Open a 40-turn thread", unit: "ms", ratio: 1.25, floor: 30 },
  { key: "idleCpuMsPerMinute", name: "Idle CPU", unit: "ms/min", ratio: 1.25, floor: 300 },
  { key: "pssMB", name: "Memory, all processes (PSS)", unit: "MB", ratio: 1.05, floor: 20 },
  { key: "rendererHeapMB", name: "Renderer JS heap", unit: "MB", ratio: 1.1, floor: 5 },
]

const runs = Number(process.env["RUNS"] ?? 5)
const idleSeconds = Number(process.env["IDLE_SECONDS"] ?? 30)
const port = Number(process.env["PORT"] ?? 9295)
const ticksPerSecond = Number(execFileSync("getconf", ["CLK_TCK"], { encoding: "utf8" }))
const seedScript = join(dirname(fileURLToPath(import.meta.url)), "seed.ts")

const processes = () =>
  readdirSync("/proc")
    .filter((entry) => /^\d+$/.test(entry))
    .flatMap((pid) => {
      try {
        const stat = readFileSync(`/proc/${pid}/stat`, "utf8")
        const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ")
        const ticks = [11, 12, 13, 14].reduce((total, index) => total + Number(fields[index]), 0)
        return [{ pid: Number(pid), ppid: Number(fields[1]), ticks }]
      } catch {
        return []
      }
    })

const processTree = (root: number) => {
  const all = processes()
  const ids = new Set([root])
  for (let size = 0; size !== ids.size;) {
    size = ids.size
    for (const candidate of all) if (ids.has(candidate.ppid)) ids.add(candidate.pid)
  }
  return all.filter((candidate) => ids.has(candidate.pid))
}

const cpuMs = (root: number) =>
  (processTree(root).reduce((total, candidate) => total + candidate.ticks, 0) * 1000) / ticksPerSecond

const pssMB = (root: number) =>
  processTree(root).reduce((total, { pid }) => {
    try {
      const kB = /^Pss:\s+(\d+) kB/m.exec(readFileSync(`/proc/${pid}/smaps_rollup`, "utf8"))?.[1]
      return total + Number(kB ?? 0) / 1024
    } catch {
      return total
    }
  }, 0)

const freePort = () =>
  new Promise<number>((resolvePort, reject) => {
    const server = createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (typeof address !== "object" || address === null) return reject(new Error("no port"))
      server.close(() => resolvePort(address.port))
    })
  })

const withApp = async <T>(
  checkout: string,
  data: string,
  body: (page: Page, pid: number, startedAt: number) => Promise<T>,
) => {
  const startedAt = Date.now()
  const child = launch(checkout, data, port)
  try {
    const page = await connect(port, startedAt + 60_000)
    try {
      return await body(page, child.pid!, startedAt)
    } finally {
      page.close()
    }
  } finally {
    await stop(child)
  }
}

const seedProfile = async (checkout: string) => {
  const data = mkdtempSync("/tmp/kk-budget-")
  const repo = join(data, "repo")
  execFileSync("git", ["init", "--quiet", "-b", "main", repo])
  execFileSync("git", [
    "-C",
    repo,
    "-c",
    "user.name=perf",
    "-c",
    "user.email=perf@example.invalid",
    "commit",
    "--quiet",
    "--allow-empty",
    "-m",
    "initial",
  ])
  const webhookPort = await freePort()
  await withApp(checkout, data, async (page) => {
    await page.waitFor(`window.hinacode.rpc("settings.get").then(() => true)`, Date.now() + 60_000)
    await page.evaluate(
      `window.hinacode.rpc("settings.set", { automations: { bindHost: "127.0.0.1", port: ${webhookPort} } })`,
    )
  })
  const seeded = JSON.parse(execFileSync(process.execPath, [seedScript, data, repo], { encoding: "utf8" })) as {
    threads: Record<string, string>
  }
  return { data, long: seeded.threads["long 200 turns"]!, medium: seeded.threads["medium 40 turns"]! }
}

const run = async (baseCheckout: string, headCheckout: string, output: string) => {
  const checkouts: Record<Build, string> = { base: resolve(baseCheckout), head: resolve(headCheckout) }
  const template = await seedProfile(checkouts.base)
  const profiles: Record<Build, string> = { base: `${template.data}-base`, head: `${template.data}-head` }
  const restoredRoute = `/thread/${template.long}`
  const results: Results = { runs, idleSeconds, samples: { base: [], head: [] } }

  const restoreLongThread = (page: Page) =>
    page.evaluate(`localStorage.setItem("hinacode.location", ${JSON.stringify(restoredRoute)})`)

  const measure = (build: Build) =>
    withApp(checkouts[build], profiles[build], async (page, pid, startedAt) => {
      const deadline = startedAt + 60_000
      await page.waitFor(`document.querySelector('a[href="/thread/${template.medium}"]') !== null`, deadline)
      if ((await page.evaluate<string | null>(`localStorage.getItem("hinacode.location")`)) !== restoredRoute)
        throw new Error(`${build} did not start on the long thread`)
      await page.evaluate(transcriptShown(""))
      const startupMs = Date.now() - startedAt
      const startupCpuMs = cpuMs(pid)
      const openMs = await page.evaluate<number>(openThread(template.medium))
      await restoreLongThread(page)
      await sleep(5000)
      const idleFrom = cpuMs(pid)
      await sleep(idleSeconds * 1000)
      const idleCpuMsPerMinute = ((cpuMs(pid) - idleFrom) * 60) / idleSeconds
      await page.send("HeapProfiler.collectGarbage")
      await page.send("Performance.enable")
      const { metrics: rendererMetrics } = await page.send<{ metrics: Array<{ name: string; value: number }> }>(
        "Performance.getMetrics",
      )
      const heap = rendererMetrics.find((metric) => metric.name === "JSHeapUsedSize")?.value ?? 0
      const sample: Sample = {
        startupMs,
        startupCpuMs: round(startupCpuMs),
        openMs: round(openMs),
        idleCpuMsPerMinute: round(idleCpuMsPerMinute),
        pssMB: round(pssMB(pid)),
        rendererHeapMB: round(heap / 1048576),
      }
      console.error(`${build}: ${JSON.stringify(sample)}`)
      return sample
    })

  try {
    for (const build of ["base", "head"] as const) {
      cpSync(template.data, profiles[build], { recursive: true })
      await withApp(checkouts[build], profiles[build], async (page, _pid, startedAt) => {
        await page.waitFor(`document.querySelector('a[href^="/thread/"]') !== null`, startedAt + 60_000)
        await restoreLongThread(page)
        await sleep(2000)
      })
    }
    for (let index = 0; index < runs; index++) {
      const order: ReadonlyArray<Build> = index % 2 === 0 ? ["base", "head"] : ["head", "base"]
      for (const build of order) results.samples[build].push(await measure(build))
    }
  } finally {
    for (const data of [template.data, ...Object.values(profiles)]) rmSync(data, { recursive: true, force: true })
  }
  writeFileSync(output, `${JSON.stringify(results, null, 2)}\n`)
}

const report = (input: string) => {
  const results = JSON.parse(readFileSync(input, "utf8")) as Results
  let failed = false
  const rows = metrics.map(({ key, name, unit, ratio, floor }) => {
    const base = median(results.samples.base.map((sample) => sample[key]))
    const head = median(results.samples.head.map((sample) => sample[key]))
    const over = head > base * ratio && head - base > floor
    failed ||= over
    const diff = head - base
    const percent = base === 0 ? "" : ` (${diff >= 0 ? "+" : ""}${((diff / base) * 100).toFixed(1)}%)`
    const budget = `${over ? "❌" : "✅"} +${Math.round((ratio - 1) * 100)}% and +${floor} ${unit}`
    return `| ${[name, `${round(base)} ${unit}`, `${round(head)} ${unit}`, `${diff >= 0 ? "+" : ""}${round(diff)}${percent}`, budget].join(" | ")} |`
  })
  console.log(`### Runtime

| | Base | This PR | Change | Fails over |
| --- | --: | --: | --: | --: |
${rows.join("\n")}

Medians of ${results.runs} launches per build, alternating, on a profile with five seeded threads. Idle CPU is measured over ${results.idleSeconds} s. A measurement fails only when it grows past both limits.`)
  return failed
}

const [command, ...rest] = process.argv.slice(2)
if (command === "run" && rest.length === 3) await run(rest[0]!, rest[1]!, rest[2]!)
else if (command === "report" && rest.length === 1) process.exitCode = report(rest[0]!) ? 1 : 0
else {
  console.error(
    "usage: budget.ts run <base-checkout> <head-checkout> <results.json>\n       budget.ts report <results.json>",
  )
  process.exit(2)
}
