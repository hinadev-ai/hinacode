import { _electron as electron, expect } from "@playwright/test"
import executablePath from "electron"
import { execFileSync } from "node:child_process"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, createWriteStream, readFileSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"
import { join, dirname, resolve as resolvePath } from "node:path"
import { createServer } from "node:net"
import { createHash } from "node:crypto"
import { launchPackaged } from "./packaged.mjs"

const [label, scenario = "history", check] = process.argv.slice(2)
if (!/^[\w-]+$/.test(label ?? "") || !["history", "claude", "footprint", "startup"].includes(scenario))
  throw new Error("usage: memory.mjs <label> [history|claude|footprint|startup] [--check]")
const root = process.cwd()
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const packagedApp = process.env.KKCODE_PERF_APP
const port = Number(process.env.KKCODE_PERF_PORT ?? 9600)
if (packagedApp && (port < 9600 || port > 9699)) throw new Error("use a CDP port from 9600 to 9699")
mkdirSync(join(root, ".context/perf"), { recursive: true })
mkdirSync(join(root, ".context/shots"), { recursive: true })
const data = mkdtempSync("/tmp/kk-memory-")
const repo = join(data, "repo")
mkdirSync(repo)
execFileSync("git", ["init", "-b", "main", repo], { stdio: "ignore" })
execFileSync(
  "git",
  [
    "-C",
    repo,
    "-c",
    "user.name=Memory benchmark",
    "-c",
    "user.email=memory@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--allow-empty",
    "-m",
    "initial",
  ],
  { stdio: "ignore" },
)
const env = { ...process.env, KKCODE_USER_DATA: data }
delete env.ELECTRON_RUN_AS_NODE
delete env.ELECTRON_RENDERER_URL
const startedAt = performance.now()
const appLog = createWriteStream(join(root, ".context/perf", `${label}-${scenario}-app.log`))
const app = packagedApp
  ? await launchPackaged({ executablePath: packagedApp, port, cwd: root, env, log: appLog })
  : await electron.launch({
      executablePath,
      args: [
        ...(packagedApp ? [`--remote-debugging-port=${port}`] : ["--no-sandbox", "--disable-gpu"]),
        "--mute-audio",
        ...(packagedApp ? [] : [join(root, "out/main/index.js")]),
      ],
      cwd: root,
      env,
    })
if (!packagedApp) {
  app.process().stdout?.pipe(appLog)
  app.process().stderr?.pipe(appLog)
}
const results = {
  label,
  scenario,
  packagedApp,
  packagedAsarSha256: packagedApp
    ? createHash("sha256")
        .update(readFileSync(join(dirname(packagedApp), "../Resources/app.asar")))
        .digest("hex")
    : null,
  revision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  diffSha256: createHash("sha256")
    .update(execFileSync("git", ["diff", "HEAD"]))
    .digest("hex"),
  samples: [],
}
const save = () =>
  writeFileSync(join(root, ".context/perf", `${label}-${scenario}-memory.json`), JSON.stringify(results, null, 2))
try {
  const page = await app.firstWindow()
  await page.waitForFunction(() => (document.getElementById("root")?.childElementCount ?? 0) > 0)
  if (
    !page
      .url()
      .startsWith(
        packagedApp
          ? `file://${resolvePath(dirname(packagedApp), "../Resources/app.asar/out/renderer")}/`
          : `file://${root}/out/renderer/`,
      )
  )
    throw new Error("wrong renderer")
  const ownership = await app.evaluate(() => ({
    cwd: process.cwd(),
    data: process.env.KKCODE_USER_DATA,
    pid: process.pid,
  }))
  if (ownership.cwd !== root || ownership.data !== data) throw new Error("wrong app")
  results.ownership = ownership
  const rpc = async (method, payload) => {
    const reply = await page.evaluate(async (request) => window.kkcode.rpc(request.method, request.payload), {
      method,
      payload,
    })
    if (reply.error) throw new Error(JSON.stringify(reply.error))
    return reply.result
  }
  await rpc("settings.get")
  results.startup = {
    firstRpcMs: performance.now() - startedAt,
    paints: await page.evaluate(() =>
      performance.getEntriesByType("paint").map(({ name, startTime }) => ({ name, startTime })),
    ),
  }
  const webhookPort = await new Promise((resolve, reject) => {
    const server = createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (typeof address !== "object" || address === null) return reject(new Error("no port"))
      server.close((error) => (error ? reject(error) : resolve(address.port)))
    })
  })
  await rpc("settings.set", { automations: { bindHost: "127.0.0.1", port: webhookPort } })
  const cdp = await page.context().newCDPSession(page)
  await cdp.send("Performance.enable")
  const observedProcesses = new Map()
  const sample = async (name) => {
    await cdp.send("HeapProfiler.collectGarbage")
    const main = await app.evaluate(async () => {
      const { Session } = process.getBuiltinModule("node:inspector")
      const session = new Session()
      session.connect()
      await new Promise((resolve, reject) =>
        session.post("HeapProfiler.collectGarbage", (e) => (e ? reject(e) : resolve())),
      )
      session.disconnect()
      return {
        ...process.memoryUsage(),
        cpu: process.cpuUsage(),
        resources: process.getActiveResourcesInfo(),
        code: process.getBuiltinModule("node:v8").getHeapCodeStatistics(),
      }
    })
    const { metrics } = await cdp.send("Performance.getMetrics")
    const metric = (n) => metrics.find((m) => m.name === n)?.value
    const processes = execFileSync("ps", ["-axo", "pid=,ppid=,rss=,comm="], { encoding: "utf8" })
      .trim()
      .split("\n")
      .map((line) => {
        const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/)
        if (!m) throw new Error("invalid ps row")
        return {
          pid: Number(m[1]),
          ppid: Number(m[2]),
          rssBytes: Number(m[3]) * 1024,
          executable: m[4].split("/").at(-1),
        }
      })
    const ids = new Set([ownership.pid])
    for (let size = -1; size !== ids.size;) {
      size = ids.size
      for (const p of processes) if (ids.has(p.ppid)) ids.add(p.pid)
    }
    const owned = processes.filter((p) => ids.has(p.pid))
    for (const process of owned) observedProcesses.set(process.pid, process.executable)
    const detachedDescendants = processes.filter(
      (p) => !ids.has(p.pid) && observedProcesses.get(p.pid) === p.executable,
    )
    const value = {
      name,
      elapsedMs: performance.now() - startedAt,
      rendererHeapBytes: metric("JSHeapUsedSize"),
      domNodes: metric("Nodes"),
      listeners: metric("JSEventListeners"),
      rssBytes: owned.reduce((n, p) => n + p.rssBytes, 0),
      appRssBytes: owned
        .filter((p) => p.executable.startsWith(packagedApp ? "kkcode" : "Electron"))
        .reduce((n, p) => n + p.rssBytes, 0),
      cliRssBytes: owned
        .filter((p) => !p.executable.startsWith(packagedApp ? "kkcode" : "Electron"))
        .reduce((n, p) => n + p.rssBytes, 0),
      processes: owned,
      detachedDescendants,
      main,
      rendererHeap: await cdp.send("Runtime.getHeapUsage"),
    }
    results.samples.push(value)
    save()
    const summary = {
      name,
      rendererHeapMiB: value.rendererHeapBytes / 1048576,
      rssMiB: value.rssBytes / 1048576,
      appRssMiB: value.appRssBytes / 1048576,
      cliRssMiB: value.cliRssBytes / 1048576,
      mainHeapMiB: main.heapUsed / 1048576,
      processes: owned.length,
    }
    if (scenario === "footprint" || scenario === "startup") {
      for (const [metricName, metricValue] of Object.entries(summary)) {
        if (metricName !== "name")
          console.log(JSON.stringify({ label, scenario, phase: name, metric: metricName, value: metricValue }))
      }
    } else console.log(JSON.stringify(summary))
  }
  const series = async (name, seconds) => {
    for (let i = 0; i < seconds; i += 5) {
      await pause(5000)
      await sample(`${name}-${i + 5}s`)
    }
  }
  await sample("empty")
  if (scenario === "startup") {
    results.workload = { idleSeconds: 15, gpu: packagedApp ? "default" : "disabled" }
    await series("empty-idle", 15)
  } else if (scenario === "footprint") {
    await series("empty-idle", 15)
    for (let i = 0; i < 3; i++) {
      mkdirSync(`${repo}-${i}`)
      execFileSync("git", ["clone", "--quiet", repo, `${repo}-${i}`])
    }
    const seed = JSON.parse(
      execFileSync(process.execPath, [join(root, "scripts/perf/seed.mjs"), data, repo, "--footprint"], {
        encoding: "utf8",
      }),
    )
    const db = new DatabaseSync(join(data, "kkcode.sqlite"))
    const digest = createHash("sha256")
    for (const row of db.prepare("SELECT * FROM message ORDER BY rowid").iterate()) digest.update(JSON.stringify(row))
    results.workload = {
      projects: 3,
      threads: 30,
      longTranscripts: 5,
      messagesPerLongTranscript: 2000,
      sha256: digest.digest("hex"),
      bytes: seed.bytes,
      idleSeconds: Number(process.env.PERF_IDLE_SECONDS ?? 300),
      gpu: packagedApp ? "default" : "disabled",
    }
    const lastMessages = Object.fromEntries(
      Object.values(seed.threads).map((id) => [
        id,
        db.prepare("SELECT id FROM message WHERE thread_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(id)
          .id,
      ]),
    )
    db.close()
    await page.reload()
    const ids = Object.entries(seed.threads)
      .filter(([name]) => name.startsWith("long"))
      .map(([, id]) => id)
    const emptyId = seed.threads["small 29"]
    await expect(page.locator(`a[href="/thread/${ids[0]}"]`)).toBeVisible()
    await series("seeded-idle", 15)
    await cdp.send("Profiler.enable")
    await cdp.send("Profiler.start")
    await app.evaluate(async () => {
      const { Session } = process.getBuiltinModule("node:inspector")
      const session = new Session()
      session.connect()
      globalThis.__kkPerfSession = session
      await new Promise((resolve, reject) => session.post("Profiler.enable", (e) => (e ? reject(e) : resolve())))
      await new Promise((resolve, reject) => session.post("Profiler.start", (e) => (e ? reject(e) : resolve())))
    })
    results.switches = []
    for (let i = 0; i < 10; i++) {
      const id = ids[i % ids.length]
      const before = performance.now()
      await page.locator(`a[href="/thread/${id}"]`).click()
      await expect(page.locator(`main article[data-message-id="${lastMessages[id]}"]`)).toBeVisible({ timeout: 30000 })
      await expect(page.getByRole("heading", { name: `long ${i % 5}`, exact: true })).toBeVisible()
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
      const value = { id, ms: performance.now() - before }
      results.switches.push(value)
      console.log(JSON.stringify({ name: "switch", ...value }))
      await sample(`opened-${i + 1}`)
      await page.locator(`a[href="/thread/${emptyId}"]`).click()
      await expect(page.getByRole("heading", { name: "small 29", exact: true })).toBeVisible()
    }
    const { profile } = await cdp.send("Profiler.stop")
    writeFileSync(join(root, ".context/perf", `${label}-renderer.cpuprofile`), JSON.stringify(profile))
    const mainProfile = await app.evaluate(async () => {
      const session = globalThis.__kkPerfSession
      const result = await new Promise((resolve, reject) =>
        session.post("Profiler.stop", (e, r) => (e ? reject(e) : resolve(r))),
      )
      session.disconnect()
      delete globalThis.__kkPerfSession
      return result.profile
    })
    writeFileSync(join(root, ".context/perf", `${label}-main.cpuprofile`), JSON.stringify(mainProfile))
    await page.screenshot({ path: join(root, ".context/perf", `${label}-left-threads.png`) })
    await series("closed-idle", results.workload.idleSeconds)
    if (process.env.PERF_SNAPSHOT === "1") {
      results.mainSnapshot = await app.evaluate(
        (_, path) => process.getBuiltinModule("node:v8").writeHeapSnapshot(path),
        join(root, ".context/perf", `${label}-main.heapsnapshot`),
      )
      const snapshotPath = join(root, ".context/perf", `${label}-renderer.heapsnapshot`)
      const snapshot = createWriteStream(snapshotPath)
      const onChunk = ({ chunk }) => snapshot.write(chunk)
      cdp.on("HeapProfiler.addHeapSnapshotChunk", onChunk)
      await cdp.send("HeapProfiler.takeHeapSnapshot")
      cdp.off("HeapProfiler.addHeapSnapshotChunk", onChunk)
      await new Promise((resolve) => snapshot.end(resolve))
    }
  } else if (scenario === "history") {
    const count = 12
    const partCount = 128
    const outputBytes = 65536
    const output = "memory benchmark output\n".repeat(Math.ceil(outputBytes / 24)).slice(0, outputBytes)
    results.workload = {
      count,
      partCount,
      outputBytes: output.length,
      sha256: createHash("sha256").update(output).digest("hex"),
    }
    const db = new DatabaseSync(join(data, "kkcode.sqlite"))
    const now = "2026-10-14T00:00:00.000Z"
    db.prepare(
      "INSERT INTO project (id,name,root_path,setup_script,created_at,updated_at) VALUES (?,?,?,NULL,?,?)",
    ).run("memory-project", "Memory audit", repo, now, now)
    const thread = db.prepare(
      "INSERT INTO thread (id,project_id,title,provider,model,status,sort_index,created_at,updated_at) VALUES (?,'memory-project',?,'claude','claude-sonnet-5-5',?,?,?,?)",
    )
    const message = db.prepare(
      "INSERT INTO message (id,thread_id,role,parts,created_at,completed_at,usage) VALUES (?,?,'assistant',?,?,?,NULL)",
    )
    db.exec("BEGIN")
    for (let i = 0; i < count; i++) {
      const id = `memory-${i}`
      thread.run(id, `Memory thread ${i}`, "running", i, now, now)
      const parts = Array.from({ length: partCount }, (_, p) => ({
        type: "tool_call",
        callId: `${id}-tool-${p}`,
        name: "Read",
        input: { file_path: `src/part-${p}.ts` },
        output,
        status: "done",
      }))
      parts.push({ type: "text", text: `Memory transcript ${i} ready.` })
      message.run(`${id}-assistant`, id, JSON.stringify(parts), now, now)
    }
    thread.run("memory-empty", "Memory empty", "idle", count, now, now)
    db.exec("COMMIT")
    results.workload.persistedBytes = db.prepare("SELECT sum(length(parts)) AS bytes FROM message").get().bytes
    db.close()
    await page.reload()
    await expect(page.locator('a[href="/thread/memory-0"]')).toBeVisible()
    const runningThreads = page.locator('a[href^="/thread/memory-"] [title="Running"]')
    await expect(runningThreads).toHaveCount(count)
    await sample("seeded")
    for (let i = 0; i < count; i++) {
      await page.locator(`a[href="/thread/memory-${i}"]`).click()
      await expect(page.getByText(`Memory transcript ${i} ready.`, { exact: true })).toBeVisible()
      if ((i + 1) % 4 === 0) await sample(`opened-${i + 1}`)
    }
    await page.locator('a[href="/thread/memory-empty"]').click()
    await expect(page.getByRole("heading", { name: "Memory empty", exact: true })).toBeVisible()
    await sample("left-running")
    const threads = await rpc("threads.list")
    await app.evaluate(({ BrowserWindow }, completedThreads) => {
      const window = BrowserWindow.getAllWindows()[0]
      for (const completedThread of completedThreads) {
        window.webContents.send("event", {
          type: "thread.event",
          threadId: completedThread.id,
          seq: 1,
          event: { type: "turn_completed" },
        })
        window.webContents.send("event", { type: "thread.updated", thread: { ...completedThread, status: "idle" } })
      }
    }, threads)
    await expect(runningThreads).toHaveCount(0)
    await sample("completed-background")
    await page.screenshot({ path: join(root, ".context/shots", `${label}-memory.png`) })
    await page.locator('a[href="/thread/memory-0"]').click()
    await expect(page.getByText("Memory transcript 0 ready.", { exact: true })).toBeVisible()
    await sample("reopened-first")
    if (check === "--check") {
      const seeded = results.samples.find((s) => s.name === "seeded")
      const hidden = results.samples.find((s) => s.name === "completed-background")
      expect(
        hidden.rendererHeapBytes - seeded.rendererHeapBytes,
        "hidden transcripts must release their tool output",
      ).toBeLessThan(20 * 1048576)
    }
  } else {
    results.workload = { threads: 3, model: "claude-sonnet-5-5", prompt: "Reply with only OK. Do not use tools." }
    const project = await rpc("projects.create", { name: "Memory lifecycle", rootPath: repo, setupScript: null })
    results.threads = []
    for (let i = 0; i < 3; i++) {
      const thread = await rpc("threads.create", { projectId: project.id })
      await rpc("threads.update", { id: thread.id, title: `Lifecycle ${i}`, model: "claude-sonnet-5-5" })
      await page.reload()
      await page.locator(`a[href="/thread/${thread.id}"]`).click()
      await page.getByRole("combobox", { name: "Message", exact: true }).fill(results.workload.prompt)
      await page.getByRole("button", { name: "Send", exact: true }).click()
      await expect
        .poll(
          async () => {
            const current = (await rpc("threads.list")).find((listed) => listed.id === thread.id)
            return (
              current && ["idle", "limited"].includes(current.status) && typeof current.providerSessionId === "string"
            )
          },
          { timeout: 120000 },
        )
        .toBe(true)
      results.transcripts ??= []
      results.transcripts.push(await rpc("threads.transcript", { threadId: thread.id }))
      results.threads.push((await rpc("threads.list")).find((t) => t.id === thread.id))
      await sample(`completed-${i + 1}`)
    }
    console.log("Waiting 70 seconds to measure idle retention")
    await new Promise((resolve) => setTimeout(resolve, 70000))
    await sample("idle-70s")
    if (check === "--check") {
      expect(
        results.samples.at(-1).processes.filter((p) => p.executable === "claude"),
        "idle Claude processes must exit",
      ).toHaveLength(0)
      expect(results.samples.at(-1).detachedDescendants, "idle cleanup must not orphan child processes").toHaveLength(0)
    }
    await page.screenshot({ path: join(root, ".context/shots", `${label}-claude-memory.png`) })
    const first = results.threads[0]
    await page.locator(`a[href="/thread/${first.id}"]`).click()
    await page.getByRole("combobox", { name: "Message", exact: true }).fill(results.workload.prompt)
    await page.getByRole("button", { name: "Send", exact: true }).click()
    await expect
      .poll(
        async () => {
          const transcript = await rpc("threads.transcript", { threadId: first.id })
          return transcript.messages.filter((message) => message.role === "assistant" && message.completedAt !== null)
            .length
        },
        { timeout: 120000 },
      )
      .toBe(2)
    const resumed = (await rpc("threads.list")).find((thread) => thread.id === first.id)
    expect(resumed.providerSessionId, "follow-up preserves the provider session").toBe(first.providerSessionId)
    results.resume = { sameSessionId: true, status: resumed.status }
    await sample("resumed-first")
  }
  save()
} catch (error) {
  results.error = String(error)
  save()
  throw error
} finally {
  await app.close()
  rmSync(data, { recursive: true, force: true })
}
