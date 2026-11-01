const [address, token] = process.argv.slice(2)
if (!address || !token) throw new Error("Usage: node scripts/site-demo/history.ts <host:port> <token>")

const prompts: Record<string, string> = {
  "Upgrade to Vite 8": "Upgrade the web app to Vite 8 and check the build.",
  "Translate settings to Japanese": "Add Japanese translations for the settings page.",
  "Rebuild the site around a working demo": "Rebuild the marketing site around a working demo, in a light theme.",
  "Render HTML in PR discussion": "Render the HTML that GitHub sends in pull request comments.",
}
const TURN_TIMEOUT_MS = 30_000

type Frame = {
  type: string
  id?: number
  envelope?: { result?: unknown }
  event?: { type: string; threadId?: string; event?: { type: string } }
}

const socket = new WebSocket(`ws://${address}/remote`)
const pending = new Map<number, (result: unknown) => void>()
const completed = new Set<string>()
let nextId = 1

const call = (method: string, payload?: unknown) =>
  new Promise<unknown>((resolve) => {
    const id = nextId++
    pending.set(id, resolve)
    socket.send(JSON.stringify({ type: "call", id, method, payload }))
  })

const finished = (threadId: string) =>
  new Promise<void>((resolve, reject) => {
    const started = Date.now()
    const check = setInterval(() => {
      if (completed.has(threadId)) resolve(clearInterval(check))
      else if (Date.now() - started > TURN_TIMEOUT_MS) reject(new Error(`No turn_completed for ${threadId}`))
    }, 200)
  })

socket.addEventListener("open", () => socket.send(JSON.stringify({ type: "auth", token })))
socket.addEventListener("message", async (message) => {
  const frame = JSON.parse(String(message.data)) as Frame
  if (frame.type === "result" && frame.id !== undefined) pending.get(frame.id)?.(frame.envelope?.result)
  if (frame.event?.type === "thread.event" && frame.event.event?.type === "turn_completed" && frame.event.threadId)
    completed.add(frame.event.threadId)
  if (frame.type !== "ready") return
  const threads = (await call("threads.list")) as Array<{ id: string; title: string }>
  for (const thread of threads) {
    const prompt = prompts[thread.title]
    if (!prompt) continue
    await call("threads.send", { threadId: thread.id, prompt })
    await finished(thread.id)
  }
  for (const thread of threads) console.log(`${thread.id}  ${thread.title}`)
  socket.close()
})
