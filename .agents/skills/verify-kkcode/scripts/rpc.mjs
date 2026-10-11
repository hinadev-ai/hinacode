#!/usr/bin/env node
// Usage: rpc.mjs <cdp-port> <method> ['<json payload>']
// Calls window.kkcode.rpc(method, payload) in the kkcode renderer over CDP and prints the result as JSON.
// Methods and payload shapes: src/shared/contract.ts (RpcMethods). Exits 1 on an rpc error envelope.
const [port, method, payload = "undefined"] = process.argv.slice(2)
if (!port || !method) {
  console.error("usage: rpc.mjs <cdp-port> <method> ['<json payload>']")
  process.exit(2)
}
const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
const page = targets.find((t) => t.type === "page" && t.url.includes("/renderer/index.html"))
if (!page) throw new Error(`no kkcode renderer page on CDP port ${port}`)
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  ws.addEventListener("open", resolve, { once: true })
  ws.addEventListener("error", reject, { once: true })
})
ws.send(
  JSON.stringify({
    id: 1,
    method: "Runtime.evaluate",
    params: { expression: `window.kkcode.rpc(${JSON.stringify(method)}, ${payload})`, awaitPromise: true, returnByValue: true },
  }),
)
const reply = await new Promise((resolve) => ws.addEventListener("message", (e) => resolve(JSON.parse(e.data)), { once: true }))
ws.close()
const envelope = reply.result?.result?.value
if (envelope === undefined) {
  console.error(JSON.stringify(reply.result?.exceptionDetails ?? reply))
  process.exit(1)
}
if ("error" in envelope) {
  console.error(JSON.stringify(envelope.error))
  process.exit(1)
}
console.log(JSON.stringify(envelope.result ?? null, null, 2))
