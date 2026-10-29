#!/usr/bin/env node
const [connection, tool, args = "{}"] = process.argv.slice(2)
if (!connection) {
  console.error("usage: mcp-call.ts '<connection json>' [tool] ['<json args>']")
  process.exit(2)
}
type Connection = { url: string; headers: Record<string, string> }
type JsonRpcResponse<T> = { id?: number; result: T; error?: unknown }
type ToolList = { tools: { name: string; description?: string }[] }
type ToolResult = { isError?: boolean; content: { text?: string }[] }

const { url, headers }: Connection = JSON.parse(connection)
let session: string | undefined
let nextId = 1
const post = async <T>(method: string, params: object, notification = false): Promise<T | undefined> => {
  const message = { jsonrpc: "2.0", method, params, ...(notification ? {} : { id: nextId++ }) }
  const response = await fetch(url, {
    method: "POST",
    headers: {
      ...headers,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(session ? { "mcp-session-id": session } : {}),
    },
    body: JSON.stringify(message),
  })
  session = response.headers.get("mcp-session-id") ?? session
  const text = await response.text()
  if (!response.ok) throw new Error(`${method}: HTTP ${response.status} ${text}`)
  if (notification || text.trim() === "") return undefined
  const json: JsonRpcResponse<T> = response.headers.get("content-type")?.includes("text/event-stream")
    ? text
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => JSON.parse(line.slice(5)))
        .find((m) => m.id === message.id)
    : JSON.parse(text)
  if (json.error) throw new Error(`${method}: ${JSON.stringify(json.error)}`)
  return json.result
}

await post("initialize", {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "verify-hinacode", version: "0" },
})
await post("notifications/initialized", {}, true)
if (!tool) {
  const { tools } = (await post<ToolList>("tools/list", {}))!
  for (const t of tools) console.log(`${t.name}\t${t.description?.split("\n")[0] ?? ""}`)
} else {
  const result = (await post<ToolResult>("tools/call", { name: tool, arguments: JSON.parse(args) }))!
  console.log(`isError=${result.isError ?? false}`)
  console.log(result.content.map((c) => c.text ?? JSON.stringify(c)).join("\n"))
  if (result.isError) process.exit(1)
}
