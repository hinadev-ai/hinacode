#!/usr/bin/env node
import { appendFileSync, mkdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { WebSocket, type MessageEvent } from "ws"

type Target = { type: string; url: string; webSocketDebuggerUrl: string }
type Reply = { id?: number; error?: unknown; result?: { result?: { value?: unknown }; exceptionDetails?: unknown } }
type Mark = { at: number; name: string }
type Sample = { label: string; case: string; provider: string; threadId: string } & Record<string, number | string>

const resultsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", ".context", "perf", "first-response")
const PROMPT = process.env.PROMPT ?? "Reply with one short sentence about the sea."
const IDLE_SESSION_TTL_MS = 60_000
const KEY_INTERVAL_MS = Number(process.env.KEY_INTERVAL_MS ?? 50)
const TURN_TIMEOUT_MS = 180_000

const [command, ...args] = process.argv.slice(2)

const usage = () => {
  console.error(
    [
      "usage: first-response.ts suite <cdp-port> <label> <projectId> [runs] [providers]",
      "       first-response.ts send <cdp-port> <label> <case> <threadId>",
      "       first-response.ts summary <label...>",
    ].join("\n"),
  )
  process.exit(2)
}

const connect = async (port: string) => {
  const targets = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()) as Target[]
  const page = targets.find((target) => target.type === "page" && target.url.includes("/renderer/index.html"))
  if (!page) throw new Error(`no hinacode renderer page on CDP port ${port}`)
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true })
    ws.addEventListener("error", reject, { once: true })
  })
  let nextId = 1
  const send = (method: string, params: object = {}) =>
    new Promise<Reply>((resolve, reject) => {
      const id = nextId++
      const onMessage = (event: MessageEvent) => {
        const reply = JSON.parse(String(event.data)) as Reply
        if (reply.id !== id) return
        ws.removeEventListener("message", onMessage)
        if (reply.error) reject(new Error(JSON.stringify(reply.error)))
        else resolve(reply)
      }
      ws.addEventListener("message", onMessage)
      ws.send(JSON.stringify({ id, method, params }))
    })
  const evaluate = async <T>(expression: string): Promise<T> => {
    const reply = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })
    if (reply.result?.exceptionDetails) throw new Error(JSON.stringify(reply.result.exceptionDetails))
    return reply.result?.result?.value as T
  }
  return { send, evaluate, close: () => ws.close() }
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const waitFor = async (check: () => Promise<boolean>, timeoutMs: number, what: string) => {
  const deadline = performance.now() + timeoutMs
  while (performance.now() < deadline) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`timed out waiting for ${what}`)
}

const recorder = (threadId: string) => `(() => {
  const marks = []
  const mark = (name) => { if (!marks.some((m) => m.name === name)) marks.push({ at: performance.now(), name }) }
  const userCount = () => document.querySelectorAll('article[aria-label="You"]').length
  const usersBefore = userCount()
  const visibleReply = () => {
    const article = [...document.querySelectorAll('article[data-message-id]')].at(-1)
    if (!article || article.getAttribute('aria-label') === 'You') return null
    const clone = article.cloneNode(true)
    clone.querySelectorAll('.text-shimmer').forEach((node) => node.remove())
    return { busy: article.getAttribute('aria-busy') === 'true', text: clone.textContent.trim() }
  }
  const observer = new MutationObserver(() => {
    if (userCount() > usersBefore) mark('userMessageShown')
    if (!marks.some((m) => m.name === 'userMessageShown')) return
    const reply = visibleReply()
    if (reply === null) return
    mark('assistantShown')
    if (reply.text !== '') mark('firstContentShown')
    if (window.__ffr.replyText !== null && reply.text.includes(window.__ffr.replyText)) mark('replyTextShown')
  })
  observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true })
  const unsubscribe = window.hinacode.onEvent((push) => {
    if (push.type === 'thread.updated' && push.thread.id === ${JSON.stringify(threadId)}) {
      mark('thread:' + push.thread.status)
    }
    if (push.type === 'message.created' && push.message.threadId === ${JSON.stringify(threadId)}) {
      mark('created:' + push.message.role)
    }
    if (push.type === 'thread.event' && push.threadId === ${JSON.stringify(threadId)}) {
      mark('event:first')
      mark('event:' + push.event.type)
      if (push.event.type === 'text_delta' && window.__ffr.replyText === null && push.event.text.trim().length >= 8) {
        window.__ffr.replyText = push.event.text.trim().slice(0, 8)
      }
    }
  })
  addEventListener('keydown', (event) => { if (event.key === 'Enter') mark('send') }, { capture: true, once: true })
  window.__ffr = { marks, replyText: null, stop: () => { observer.disconnect(); unsubscribe() } }
})()`

const sendOnce = async (port: string, label: string, caseName: string, threadId: string) => {
  const cdp = await connect(port)
  const provider = await cdp.evaluate<string>(
    `window.hinacode.rpc("threads.list").then(({ result }) => result.find((t) => t.id === ${JSON.stringify(threadId)}).provider)`,
  )
  await cdp.evaluate(`localStorage.setItem("hinacode.location", ${JSON.stringify(`/thread/${threadId}`)})`)
  await cdp.send("Page.reload")
  await waitFor(
    () => cdp.evaluate<boolean>(`!!document.querySelector('[role=combobox][aria-label="Message"]')`),
    30_000,
    "composer",
  )
  await waitFor(
    () =>
      cdp.evaluate<boolean>(
        `!document.querySelector('article[aria-busy="true"]') && !document.querySelector('button[aria-label="Stop"]')`,
      ),
    TURN_TIMEOUT_MS,
    "idle thread",
  )
  await cdp.evaluate(recorder(threadId))
  await cdp.evaluate(`document.querySelector('[role=combobox][aria-label="Message"]').focus()`)
  for (const char of PROMPT) {
    await cdp.send("Input.insertText", { text: char })
    await pause(KEY_INTERVAL_MS)
  }
  await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 })
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 })
  await waitFor(
    () =>
      cdp.evaluate<boolean>(
        `window.__ffr.marks.some((m) => m.name === "event:turn_completed" || m.name === "event:turn_failed")`,
      ),
    TURN_TIMEOUT_MS,
    "turn end",
  )
  await waitFor(
    () => cdp.evaluate<boolean>(`window.__ffr.marks.some((m) => m.name === "replyTextShown")`),
    5_000,
    "reply text on screen",
  ).catch(() => undefined)
  const marks = await cdp.evaluate<Mark[]>(`(() => { window.__ffr.stop(); return window.__ffr.marks })()`)
  cdp.close()
  const start = marks.find((m) => m.name === "send")?.at
  if (start === undefined) throw new Error("Enter never reached the page")
  const sample: Sample = { label, case: caseName, provider, threadId }
  for (const { name, at } of marks) sample[name] = Math.round(at - start)
  mkdirSync(resultsDir, { recursive: true })
  appendFileSync(join(resultsDir, `${label}.jsonl`), `${JSON.stringify(sample)}\n`)
  console.log(JSON.stringify(sample))
}

const createDraft = async (port: string, projectId: string, provider: string) => {
  const cdp = await connect(port)
  const draft = await cdp.evaluate<{ result: { id: string } }>(
    `window.hinacode.rpc("threads.draft", ${JSON.stringify({ projectId })})`,
  )
  await cdp.evaluate(`window.hinacode.rpc("threads.update", ${JSON.stringify({ id: draft.result.id, provider })})`)
  cdp.close()
  return draft.result.id
}

const suite = async (port: string, label: string, projectId: string, runs: number, providers: string[]) => {
  for (const provider of providers) {
    const threadIds: string[] = []
    for (let run = 0; run < runs; run++) {
      const threadId = await createDraft(port, projectId, provider)
      threadIds.push(threadId)
      await sendOnce(port, label, "cold-new", threadId)
      await pause(2_000)
      await sendOnce(port, label, "warm", threadId)
    }
    await pause(IDLE_SESSION_TTL_MS + 10_000)
    for (const threadId of threadIds) await sendOnce(port, label, "cold-idle", threadId)
  }
}

const SEGMENTS = [
  ["user message on screen", "userMessageShown"],
  ["Thinking… shimmer", "assistantShown"],
  ["provider bound", "event:session_bound"],
  ["first agent event", "event:first"],
  ["first content on screen", "firstContentShown"],
  ["first text delta", "event:text_delta"],
  ["reply text on screen", "replyTextShown"],
] as const

const median = (values: number[]) => {
  const sorted = values.toSorted((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  const upper = sorted[middle] ?? 0
  return sorted.length % 2 === 1 ? upper : Math.round(((sorted[middle - 1] ?? 0) + upper) / 2)
}

const summary = (labels: string[]) => {
  const samples = labels.flatMap((label) =>
    readFileSync(join(resultsDir, `${label}.jsonl`), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Sample),
  )
  const groups = Map.groupBy(samples, (sample) => `${sample.provider} ${sample.case}`)
  const columns = labels.flatMap((label) => [label])
  for (const [group, groupSamples] of [...groups].toSorted(([a], [b]) => a.localeCompare(b))) {
    const counts = columns.map((label) => groupSamples.filter((sample) => sample.label === label).length)
    console.log(`\n### ${group} (n = ${counts.join(" / ")})\n`)
    console.log(`| Milestone, ms after Enter | ${columns.join(" | ")} |`)
    console.log(`| --- | ${columns.map(() => "---:").join(" | ")} |`)
    for (const [title, key] of SEGMENTS) {
      const cells = columns.map((label) => {
        const values = groupSamples
          .filter((sample) => sample.label === label && typeof sample[key] === "number")
          .map((sample) => sample[key] as number)
        return values.length === 0 ? "n/a" : String(median(values))
      })
      console.log(`| ${title} | ${cells.join(" | ")} |`)
    }
  }
}

const [first = "", second = "", third = "", fourth, fifth] = args
if (command === "suite" && args.length >= 3)
  await suite(first, second, third, Number(fourth ?? 5), (fifth ?? "claude,codex").split(","))
else if (command === "send" && fourth !== undefined) await sendOnce(first, second, third, fourth)
else if (command === "summary" && args.length > 0) summary(args)
else usage()
