import { mkdir, writeFile } from "node:fs/promises"
import { createServer, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { join } from "node:path"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"

export const FAKE_MODEL_ID = "fake-model"
const FAKE_USAGE = { input_tokens: 7, output_tokens: 3, total_tokens: 10 }

export interface ScriptedCall {
  readonly when: string
  readonly name: string
  readonly arguments: object
}

export interface FakeEndpoint {
  readonly home: string
  readonly baseUrl: string
  script: (call: ScriptedCall) => void
  hold: (when: string) => void
  rateLimit: (when: string, resetsAt?: number) => void
  holdSummaries: () => () => void
  requested: (when: string) => Promise<void>
  close: () => Promise<void>
}

const sse = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`

const frame = (id: string, status: string, extra: object = {}) => ({
  id,
  object: "response",
  model: FAKE_MODEL_ID,
  status,
  output: [],
  ...extra,
})

const catalog = JSON.stringify({
  object: "list",
  data: [
    {
      id: FAKE_MODEL_ID,
      object: "model",
      metadata: {
        "muse-code": { release_date: "2026-01-01", is_hidden: false, limit: { context: 1_000_000, output: 1024 } },
      },
    },
  ],
})

type Tool = {
  readonly name?: string
  readonly type?: string
  readonly tools?: ReadonlyArray<Tool>
  readonly parameters?: { readonly required?: ReadonlyArray<string> }
}

const offeredTools = (body: string): Array<Tool> => {
  let tools: ReadonlyArray<Tool> = []
  try {
    tools = (JSON.parse(body) as { tools?: ReadonlyArray<Tool> }).tools ?? []
  } catch {}
  return tools.flatMap((tool) => (tool.type === "namespace" ? (tool.tools ?? []) : [tool]))
}

const offers = (body: string, name: string) => offeredTools(body).some((tool) => tool.name === name)

const created = (id: string) =>
  sse({ type: "response.created", sequence_number: 1, response: frame(id, "in_progress") })
const completed = (id: string) =>
  sse({ type: "response.completed", sequence_number: 3, response: frame(id, "completed", { usage: FAKE_USAGE }) })

const replyWithTool = (response: ServerResponse, call: ScriptedCall, n: number) => {
  const id = `resp_tool_${n}`
  response.write(created(id))
  response.write(
    sse({
      type: "response.function_call_arguments.done",
      sequence_number: 2,
      output_index: 0,
      item_id: `fc_${n}`,
      name: call.name,
      call_id: `call_${n}`,
      arguments: JSON.stringify(call.arguments),
    }),
  )
  response.end(completed(id))
}

const replyWithSummary = (response: ServerResponse, summarizer: Tool) => {
  const summary = Object.fromEntries((summarizer.parameters?.required ?? []).map((field) => [field, "None known."]))
  const call = {
    type: "function_call",
    id: "fc_summary",
    call_id: "call_summary",
    name: "generate_summary",
    arguments: JSON.stringify(summary),
    status: "completed",
  }
  response.writeHead(200, { "content-type": "application/json" })
  response.end(JSON.stringify(frame("resp_summary", "completed", { usage: FAKE_USAGE, output: [call] })))
}

const replyWithText = (response: ServerResponse, text: string, held: boolean) => {
  response.write(created("resp_text"))
  response.write(
    sse({
      type: "response.output_text.delta",
      sequence_number: 2,
      output_index: 0,
      item_id: "msg_1",
      content_index: 0,
      delta: text,
    }),
  )
  if (!held) response.end(completed("resp_text"))
}

export const startFakeEndpoint = async (root: string, replyText: string): Promise<FakeEndpoint> => {
  const bodies: Array<string> = []
  const scripts: Array<ScriptedCall> = []
  const holds: Array<string> = []
  const rateLimits: Array<{ readonly when: string; readonly resetsAt?: number }> = []
  let heldSummaries: Array<() => void> | undefined
  const waiting = new Set<{ readonly when: string; readonly resolve: () => void }>()
  let scripted = 0

  const server = createServer((request, response) => {
    const chunks: Array<Buffer> = []
    request.on("data", (chunk: Buffer) => chunks.push(chunk))
    request.on("end", () => {
      if (request.method === "GET" && (request.url ?? "").endsWith("/muse-code/models")) {
        response.writeHead(200, { "content-type": "application/json" })
        response.end(catalog)
        return
      }
      const body = Buffer.concat(chunks).toString("utf8")
      bodies.push(body)
      for (const waiter of waiting) {
        if (!body.includes(waiter.when)) continue
        waiting.delete(waiter)
        waiter.resolve()
      }
      const limit = rateLimits.find(({ when }) => body.includes(when))
      if (limit !== undefined) {
        // FIXME: Retry-After keeps Muse's backoff, up to a minute a retry, out of the test
        response.writeHead(429, { "content-type": "application/json", "retry-after": "0" })
        const error = { message: "Rate limit exceeded", code: "rate_limit_exceeded", resets_at: limit.resetsAt }
        response.end(JSON.stringify({ error }))
        return
      }
      const summarizer = offeredTools(body).find((tool) => tool.name === "generate_summary")
      if (summarizer !== undefined) {
        const answer = () => replyWithSummary(response, summarizer)
        if (heldSummaries === undefined) answer()
        else heldSummaries.push(answer)
        return
      }
      response.writeHead(200, { "content-type": "text/event-stream" })
      // FIXME: Muse's reminder agents call the endpoint too and may land first
      const call = scripts.findIndex((script) => body.includes(script.when) && offers(body, script.name))
      if (call !== -1) {
        scripted += 1
        replyWithTool(response, scripts.splice(call, 1)[0]!, scripted)
        return
      }
      replyWithText(
        response,
        replyText,
        holds.some((when) => body.includes(when)),
      )
    })
    request.on("error", () => undefined)
    response.on("error", () => undefined)
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  const home = join(root, "home")
  const config = join(home, ".config", "muse")
  await mkdir(config, { recursive: true })
  await writeFile(
    join(config, "settings.json"),
    JSON.stringify({ schema_version: 1, endpoint_transport: { base_url: baseUrl, auth: "bearer" } }),
  )
  await writeFile(
    join(config, "auth.json"),
    JSON.stringify({ schema_version: 1, providers: { meta: { api_key: "fake-endpoint-dummy-key" } } }),
  )

  return {
    home,
    baseUrl,
    script: (call) => scripts.push(call),
    hold: (when) => holds.push(when),
    rateLimit: (when, resetsAt) => rateLimits.push({ when, resetsAt }),
    holdSummaries: () => {
      const held: Array<() => void> = []
      heldSummaries = held
      return () => {
        heldSummaries = undefined
        for (const answer of held.splice(0)) answer()
      }
    },
    requested: (when) =>
      bodies.some((body) => body.includes(when))
        ? Promise.resolve()
        : new Promise((resolve) => waiting.add({ when, resolve })),
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}

// FIXME: Muse fails the turn before any model call when the hinacode MCP server is unreachable
export const startFakeMcpServer = async () => {
  const server = createServer((request, response) => {
    const mcp = new McpServer({ name: "hinacode", version: "0.0.0" })
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
    response.on("close", () => {
      void transport.close()
      void mcp.close()
    })
    void mcp.connect(transport).then(() => transport.handleRequest(request, response))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}
