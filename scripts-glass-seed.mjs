// usage: node seed.mjs <port> <token> <repoPath>  -> prints thread id
const [port, token, repo] = process.argv.slice(2)
const ws = new WebSocket(`ws://127.0.0.1:${port}/remote`)
let next = 1
const pending = new Map()
const call = (method, payload) =>
  new Promise((resolve, reject) => {
    const id = next++
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ type: "call", id, method, ...(payload === undefined ? {} : { payload }) }))
  })
ws.onmessage = async ({ data }) => {
  const frame = JSON.parse(String(data))
  if (frame.type === "challenge") return ws.send(JSON.stringify({ type: "auth", token }))
  if (frame.type === "result") {
    const p = pending.get(frame.id)
    pending.delete(frame.id)
    "error" in frame.envelope || "failure" in frame.envelope ? p.reject(new Error(JSON.stringify(frame.envelope))) : p.resolve(frame.envelope.result)
  }
  if (frame.type !== "ready") return
  try {
    const project = await call("projects.create", { name: "hinacode", rootPath: repo, setupScript: null })
    for (const prompt of ["Refactor the composer dock", "Add Liquid Glass to the toolbar", "Fix the flaky scroll test", "Show PR merge state", "Ports panel polish", "Linear poller backoff", "Split view on iPad", "Terminal attach", "Search threads", "Relay reconnect", "Settings grouping", "Webhook HMAC check"]) {
      const thread = await call("threads.create", { projectId: project.id })
      await call("threads.send", { threadId: thread.id, prompt })
      console.log(thread.id)
    }
    setTimeout(() => process.exit(0), 3000)
  } catch (error) {
    console.error(error)
    process.exit(1)
  }
}
ws.onerror = (e) => { console.error("ws error", e.message, e.error); process.exit(1) }
ws.onclose = (e) => { console.error("closed", e.code, e.reason); process.exit(1) }
