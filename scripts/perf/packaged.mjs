import { chromium } from "@playwright/test"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { createServer } from "node:net"
import { setTimeout as pause } from "node:timers/promises"

// Keep the packaged launch free of Playwright's implicit --remote-debugging-port=0.
export async function launchPackaged({ executablePath, port, cwd, env, log }) {
  const inspectorPort = port + 10000
  for (const candidate of [port, inspectorPort]) {
    const probe = createServer()
    await new Promise((resolve, reject) => {
      probe.once("error", reject)
      probe.listen(candidate, "127.0.0.1", () => probe.close((error) => (error ? reject(error) : resolve())))
    })
  }
  const child = spawn(
    executablePath,
    ["--use-mock-keychain", `--remote-debugging-port=${port}`, `--inspect=127.0.0.1:${inspectorPort}`],
    { cwd, env },
  )
  child.stdout.pipe(log, { end: false })
  child.stderr.pipe(log, { end: false })
  const exited = once(child, "exit").then(([code, signal]) => {
    log.write(JSON.stringify({ exit: { code, signal }, at: new Date().toISOString() }) + "\n")
  })
  let browser, ws
  const pending = new Map()
  try {
    const ready = async (candidate) => {
      const deadline = performance.now() + 30000
      while (performance.now() < deadline) {
        if (child.exitCode !== null || child.signalCode !== null) throw new Error("packaged app exited during launch")
        try {
          const response = await fetch(`http://127.0.0.1:${candidate}/json`, { signal: AbortSignal.timeout(1000) })
          if (response.ok) return await response.json()
        } catch {}
        await pause(100)
      }
      throw new Error(`no debugger on port ${candidate} after 30 seconds`)
    }
    const targets = await ready(inspectorPort)
    ws = new WebSocket(targets[0].webSocketDebuggerUrl)
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve, { once: true })
      ws.addEventListener("error", reject, { once: true })
    })
    let nextId = 0
    ws.addEventListener("message", ({ data }) => {
      const reply = JSON.parse(data)
      pending.get(reply.id)?.(reply)
    })
    ws.addEventListener("close", () => {
      for (const settle of pending.values()) settle({ error: "main inspector closed" })
    })
    const evaluate = async (fn, arg) => {
      const expression = `(${fn})(process.getBuiltinModule("node:module").createRequire(process.resourcesPath + "/app.asar/package.json")("electron"), ${JSON.stringify(arg) ?? "undefined"})`
      return await new Promise((resolve, reject) => {
        const id = ++nextId
        const timeout = setTimeout(() => {
          pending.delete(id)
          reject(new Error("main evaluation timed out"))
        }, 30000)
        pending.set(id, (reply) => {
          clearTimeout(timeout)
          pending.delete(id)
          if (reply.error || reply.result.exceptionDetails) reject(new Error(JSON.stringify(reply)))
          else resolve(reply.result.result.value)
        })
        ws.send(
          JSON.stringify({
            id,
            method: "Runtime.evaluate",
            params: { expression, awaitPromise: true, returnByValue: true },
          }),
        )
      })
    }
    const owner = await evaluate(({ app }) => ({
      pid: process.pid,
      data: process.env.KKCODE_USER_DATA,
      hasApp: typeof app?.quit === "function",
    }))
    if (owner.pid !== child.pid || owner.data !== env.KKCODE_USER_DATA || !owner.hasApp)
      throw new Error("wrong main inspector")
    await ready(port)
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 30000 })
    const context = browser.contexts()[0]
    const page = context.pages()[0] ?? (await context.waitForEvent("page", { timeout: 30000 }))
    return {
      firstWindow: async () => page,
      evaluate,
      process: () => child,
      close: async () => {
        if (child.exitCode === null && child.signalCode === null) {
          await evaluate(({ app }) => app.quit()).catch(() => {})
          ws.close()
          await browser.close()
          await Promise.race([exited, pause(5000)])
        }
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM")
        ws.close()
        await browser.close()
        await exited
      },
    }
  } catch (error) {
    ws?.close()
    await browser?.close()
    child.kill("SIGTERM")
    await exited
    throw error
  }
}
