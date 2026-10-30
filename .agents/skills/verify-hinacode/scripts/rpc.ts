#!/usr/bin/env node
const [port, method, payload = "undefined"] = process.argv.slice(2)
if (!port || !method) {
  console.error("usage: rpc.ts <cdp-port> <method> ['<json payload>']")
  process.exit(2)
}
type Target = { type: string; url: string; webSocketDebuggerUrl: string }
type Reply = { result?: { result?: { value?: { result?: unknown; error?: unknown } }; exceptionDetails?: unknown } }

const targets = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()) as Target[]
const page = targets.find((t) => t.type === "page" && t.url.includes("/renderer/index.html"))
if (!page) throw new Error(`no hinacode renderer page on CDP port ${port}`)
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  ws.addEventListener("open", resolve, { once: true })
  ws.addEventListener("error", reject, { once: true })
})
ws.send(
  JSON.stringify({
    id: 1,
    method: "Runtime.evaluate",
    params: {
      expression: `window.hinacode.rpc(${JSON.stringify(method)}, ${payload})`,
      awaitPromise: true,
      returnByValue: true,
    },
  }),
)
const reply = await new Promise<Reply>((resolve) =>
  ws.addEventListener("message", (e) => resolve(JSON.parse(e.data)), { once: true }),
)
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
process.stdout.write(`${JSON.stringify(envelope.result ?? null, null, 2)}\n`, () => process.exit(0))
