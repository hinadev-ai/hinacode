#!/usr/bin/env node
import type { IncomingMessage, ServerResponse } from "node:http"
import { resolve } from "node:path"
import { createServer, type Plugin } from "vite"
import { methodKind, type RpcMethod } from "../../src/shared/contract.ts"
import { scenarios } from "./scenarios.ts"

const port = Number(process.env.UI_STATES_PORT ?? 4431)
const cdpPort = Number(process.env.UI_STATES_CDP_PORT ?? 9241)
const repo = resolve(import.meta.dirname, "../..")
const EVENT_POLL_MS = 200

type Target = { type: string; url: string; webSocketDebuggerUrl: string }
type CdpReply = {
  id?: number
  result?: { result?: { value?: unknown }; exceptionDetails?: { text?: string; exception?: { description?: string } } }
  error?: { message: string }
}

let socket: Promise<WebSocket> | null = null
let nextId = 1
const waiting = new Map<number, (reply: CdpReply) => void>()

const connect = async () => {
  const targets = (await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json()) as Array<Target>
  const page = targets.find((target) => target.type === "page" && target.url.includes("/renderer/index.html"))
  if (!page) throw new Error(`no HinaCode renderer page on CDP port ${cdpPort}`)
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((done, fail) => {
    ws.addEventListener("open", done, { once: true })
    ws.addEventListener("error", fail, { once: true })
  })
  ws.addEventListener("message", (message) => {
    const reply = JSON.parse(String(message.data)) as CdpReply
    if (reply.id === undefined) return
    waiting.get(reply.id)?.(reply)
    waiting.delete(reply.id)
  })
  ws.addEventListener("close", () => {
    socket = null
  })
  return ws
}

const evaluate = async (expression: string): Promise<unknown> => {
  socket ??= connect().catch((cause: unknown) => {
    socket = null
    throw cause
  })
  const ws = await socket
  const id = nextId++
  const reply = await new Promise<CdpReply>((done) => {
    waiting.set(id, done)
    ws.send(
      JSON.stringify({
        id,
        method: "Runtime.evaluate",
        params: { expression, awaitPromise: true, returnByValue: true },
      }),
    )
  })
  const thrown = reply.error?.message ?? reply.result?.exceptionDetails?.exception?.description
  if (thrown !== undefined) throw new Error(thrown)
  return reply.result?.result?.value
}

const readBody = async (request: IncomingMessage) => {
  const chunks: Array<Buffer> = []
  for await (const chunk of request) chunks.push(chunk as Buffer)
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
    method: RpcMethod
    payload: unknown
    environment?: string
  }
}

const sendJson = (response: ServerResponse, value: unknown) => {
  response.setHeader("content-type", "application/json")
  response.end(JSON.stringify(value))
}

const forwardRpc = async (request: IncomingMessage, response: ServerResponse) => {
  const { method, payload, environment } = await readBody(request)
  if (methodKind[method] !== "read") {
    sendJson(response, { error: { tag: "UiStatesReadOnly", message: `${method} changes state; override it instead` } })
    return
  }
  const args = [method, payload, environment].map((value) => JSON.stringify(value) ?? "undefined").join(", ")
  try {
    sendJson(response, await evaluate(`window.hinacode.rpc(${args})`))
  } catch (cause) {
    sendJson(response, { error: { tag: "UiStatesBridge", message: String(cause) } })
  }
}

const BUFFER_EVENTS = `(() => {
  if (!window.__uiStatesEvents) {
    window.__uiStatesEvents = []
    window.hinacode.onEvent((event) => {
      if (window.__uiStatesEvents.length < 1000) window.__uiStatesEvents.push(event)
    })
  }
  return window.__uiStatesEvents.splice(0)
})()`

const listeners = new Set<ServerResponse>()
let polling: ReturnType<typeof setInterval> | null = null

const pollEvents = async () => {
  const events = (await evaluate(BUFFER_EVENTS).catch(() => [])) as Array<unknown>
  for (const event of events) for (const listener of listeners) listener.write(`data: ${JSON.stringify(event)}\n\n`)
}

const streamEvents = (request: IncomingMessage, response: ServerResponse) => {
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" })
  response.write(": connected\n\n")
  listeners.add(response)
  polling ??= setInterval(() => void pollEvents(), EVENT_POLL_MS)
  request.on("close", () => {
    listeners.delete(response)
    if (listeners.size > 0 || polling === null) return
    clearInterval(polling)
    polling = null
  })
}

const bridge = (): Plugin => ({
  name: "ui-states-bridge",
  configureServer: (server) => {
    server.middlewares.use((request, response, next) => {
      const path = request.url?.split("?")[0]
      if (request.method === "POST" && path === "/rpc") void forwardRpc(request, response)
      else if (path === "/events") streamEvents(request, response)
      else if (path === "/runtime") void evaluate("window.hinacode.runtime").then((value) => sendJson(response, value))
      else if (path === "/scenarios")
        sendJson(
          response,
          scenarios.map((scenario) => scenario.name),
        )
      else next()
    })
  },
})

const server = await createServer({
  configFile: resolve(repo, "apps/web/vite.config.ts"),
  root: import.meta.dirname,
  server: { host: "127.0.0.1", port, strictPort: true },
  plugins: [bridge()],
})
await server.listen()
console.log(`ui-states ready: http://127.0.0.1:${port}/?scenario=${scenarios[0]?.name}`)
