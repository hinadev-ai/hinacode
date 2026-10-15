#!/usr/bin/env node
import { createServer as tcpServer, connect } from "node:net"
import { createServer as httpServer } from "node:http"

const [listenArg, targetArg, controlArg] = process.argv.slice(2)
if (!listenArg || !targetArg || !controlArg) {
  console.error("Usage: node scripts/flaky-proxy.mjs <listen-port> <target-port> <control-port> [target-host]")
  process.exit(1)
}
const port = (value) => {
  const number = Number(value)
  if (!Number.isInteger(number) || number < 1 || number > 65535) throw new Error(`Invalid port: ${value}`)
  return number
}
const pairs = new Set()
let mode = "pass"
let delayMs = 0
const timers = new Set()

const reset = () => {
  for (const timer of timers) clearTimeout(timer)
  timers.clear()
  for (const { client, upstream } of pairs) {
    client.destroy()
    upstream.destroy()
  }
  pairs.clear()
}

const proxy = tcpServer((client) => {
  const upstream = connect(port(targetArg), process.argv[5] ?? "127.0.0.1")
  const pair = { client, upstream, directions: [] }
  pairs.add(pair)
  const forward = (from, to) => {
    const held = []
    const resume = () => {
      if (mode === "blackhole" || mode === "reset" || to.destroyed) return
      while (held.length > 0) {
        if (!to.write(held.shift())) return
      }
      from.resume()
    }
    pair.directions.push({ resume })
    from.on("data", (data) => {
      if (mode === "reset") return
      if (mode === "blackhole") {
        held.push(data)
        from.pause()
        return
      }
      if (mode === "delay") {
        from.pause()
        const timer = setTimeout(() => {
          timers.delete(timer)
          held.push(data)
          resume()
        }, delayMs)
        timers.add(timer)
      } else if (!to.write(data)) from.pause()
    })
    to.on("drain", resume)
    from.on("end", () => to.end())
    from.on("error", () => to.destroy())
    from.on("close", () => {
      pairs.delete(pair)
      to.destroy()
    })
  }
  forward(client, upstream)
  forward(upstream, client)
  if (mode === "blackhole") {
    client.pause()
    upstream.pause()
  }
  if (mode === "reset") {
    client.destroy()
    upstream.destroy()
  }
})

const control = httpServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1")
  const command = decodeURIComponent(url.pathname.slice(1)).trim().split(/\s+/)
  if (request.method === "POST") {
    const next = command[0]
    if (!["pass", "blackhole", "reset", "delay"].includes(next)) return response.writeHead(400).end("Unknown mode")
    const delay = Number(command[1] ?? url.searchParams.get("ms"))
    if (next === "delay" && (!Number.isFinite(delay) || delay < 0 || delay > 60_000)) {
      return response.writeHead(400).end("delay requires 0..60000 ms")
    }
    mode = next
    delayMs = next === "delay" ? delay : 0
    if (mode === "reset") reset()
    else {
      for (const pair of pairs) {
        if (mode === "blackhole") {
          pair.client.pause()
          pair.upstream.pause()
        } else for (const direction of pair.directions) direction.resume()
      }
    }
  } else if (request.method !== "GET") return response.writeHead(405).end()
  response
    .writeHead(200, { "content-type": "application/json" })
    .end(JSON.stringify({ mode, delayMs, sockets: pairs.size }))
})
proxy.listen(port(listenArg), "127.0.0.1")
control.listen(port(controlArg), "127.0.0.1", () => {
  console.log(
    `Proxy 127.0.0.1:${listenArg} -> ${process.argv[5] ?? "127.0.0.1"}:${targetArg}; control http://127.0.0.1:${controlArg}`,
  )
})
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    reset()
    proxy.close()
    control.close()
  })
}
