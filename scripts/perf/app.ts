import { type ChildProcess, spawn } from "node:child_process"
import { createRequire } from "node:module"
import { join } from "node:path"
import { WebSocket } from "ws"

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export const median = (values: ReadonlyArray<number>) => {
  const sorted = values.toSorted((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)] ?? 0
}

export const round = (value: number) => Math.round(value * 10) / 10

export type Page = Awaited<ReturnType<typeof connect>>

export const connect = async (port: number, deadline: number) => {
  let page: { webSocketDebuggerUrl: string } | undefined
  while (!page) {
    if (Date.now() > deadline) throw new Error(`no renderer on CDP port ${port}`)
    const targets = await fetch(`http://127.0.0.1:${port}/json`)
      .then(
        (response) => response.json() as Promise<Array<{ type: string; url: string; webSocketDebuggerUrl: string }>>,
      )
      .catch(() => [])
    page = targets.find((target) => target.type === "page" && target.url.includes("/renderer/index.html"))
    if (!page) await sleep(10)
  }
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true })
    ws.addEventListener("error", reject, { once: true })
  })
  let nextId = 1
  const pending = new Map<number, (reply: { error?: unknown; result?: unknown }) => void>()
  ws.addEventListener("message", (event) => {
    const reply = JSON.parse(event.data.toString())
    pending.get(reply.id)?.(reply)
    pending.delete(reply.id)
  })

  const send = <T>(method: string, params: object = {}) =>
    new Promise<T>((resolve, reject) => {
      const id = nextId++
      pending.set(id, (reply) =>
        reply.error ? reject(new Error(JSON.stringify(reply.error))) : resolve(reply.result as T),
      )
      ws.send(JSON.stringify({ id, method, params }))
    })

  const evaluate = async <T>(expression: string) => {
    const reply = await send<{ result?: { value: T }; exceptionDetails?: unknown }>("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    })
    if (reply.exceptionDetails) throw new Error(JSON.stringify(reply.exceptionDetails))
    return reply.result!.value
  }

  const waitFor = async (expression: string, until: number) => {
    while (!(await evaluate<boolean>(expression).catch(() => false))) {
      if (Date.now() > until) throw new Error(`timed out waiting for ${expression}`)
      await sleep(10)
    }
  }

  return { send, evaluate, waitFor, close: () => ws.close() }
}

export const launch = (checkout: string, data: string, port: number, env: Record<string, string> = {}) =>
  spawn(
    createRequire(join(checkout, "package.json"))("electron") as string,
    ["--no-sandbox", "--disable-gpu", `--remote-debugging-port=${port}`, join(checkout, "out", "main", "index.js")],
    {
      cwd: checkout,
      detached: true,
      stdio: ["ignore", "ignore", "ignore"],
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter(
            ([key]) => key !== "WAYLAND_DISPLAY" && key !== "ELECTRON_OZONE_PLATFORM_HINT",
          ),
        ),
        XDG_SESSION_TYPE: "x11",
        DISPLAY: process.env["DISPLAY_FOR_PERF"] ?? ":99",
        HINACODE_USER_DATA: data,
        HINACODE_MOCK_AGENTS: "stream",
        ...env,
      },
    },
  )

const signalGroup = (pid: number, signal: NodeJS.Signals) => {
  try {
    process.kill(-pid, signal)
  } catch {
    return
  }
}

export const stop = async (child: ChildProcess) => {
  if (child.pid === undefined || child.exitCode !== null) return
  const exited = new Promise((resolve) => child.once("exit", resolve))
  signalGroup(child.pid, "SIGTERM")
  await Promise.race([exited, sleep(5000)])
  signalGroup(child.pid, "SIGKILL")
}

export const transcriptShown = (click: string) => `(async () => {
  const frame = () => new Promise((resolve) => requestAnimationFrame(resolve))
  const t0 = performance.now()
  ${click}
  let last = -1, stable = 0
  while (stable < 2) {
    await frame()
    const articles = document.querySelectorAll("main article")
    const shown = articles.length > 0 && articles[articles.length - 1].checkVisibility({ opacityProperty: true })
    if (shown && articles.length === last) stable++; else stable = 0
    last = articles.length
    if (performance.now() - t0 > 30000) throw new Error("timed out waiting for the transcript")
  }
  return performance.now() - t0
})()`

export const openThread = (id: string) =>
  transcriptShown(`const link = document.querySelector('a[href="/thread/${id}"]')
  if (!link) throw new Error("no sidebar link for ${id}")
  link.click()`)
