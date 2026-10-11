#!/usr/bin/env node
// Usage: mcp-call.mjs <mcp-url> [tool] ['<json args>']
// Talks to kkcode's built-in MCP server as an agent would (streamable HTTP, JSON-RPC).
// Without a tool it lists tools. <mcp-url> comes from `rpc.mjs <port> mcp.url '{"threadId":"..."}'`
// and already carries the thread and the per-process token.
const [url, tool, args = "{}"] = process.argv.slice(2)
if (!url) {
  console.error("usage: mcp-call.mjs <mcp-url> [tool] ['<json args>']")
  process.exit(2)
}
let session
let nextId = 1
const post = async (method, params, notification = false) => {
  const message = { jsonrpc: "2.0", method, params, ...(notification ? {} : { id: nextId++ }) }
  const response = await fetch(url, {
    method: "POST",
    headers: {
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
  const json = response.headers.get("content-type")?.includes("text/event-stream")
    ? text.split("\n").filter((line) => line.startsWith("data:")).map((line) => JSON.parse(line.slice(5))).find((m) => m.id === message.id)
    : JSON.parse(text)
  if (json.error) throw new Error(`${method}: ${JSON.stringify(json.error)}`)
  return json.result
}

await post("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "verify-kkcode", version: "0" } })
await post("notifications/initialized", {}, true)
if (!tool) {
  const { tools } = await post("tools/list", {})
  for (const t of tools) console.log(`${t.name}\t${t.description?.split("\n")[0] ?? ""}`)
} else {
  const result = await post("tools/call", { name: tool, arguments: JSON.parse(args) })
  console.log(`isError=${result.isError ?? false}`)
  console.log(result.content.map((c) => c.text ?? JSON.stringify(c)).join("\n"))
  if (result.isError) process.exit(1)
}
