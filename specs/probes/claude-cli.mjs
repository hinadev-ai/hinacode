// Usage: node specs/probes/claude-cli.mjs <after-generation|while-streaming|two-steers|interrupt-queued>
// Each run makes a few Haiku requests.
import { query } from "@anthropic-ai/claude-agent-sdk"
import { execFileSync } from "node:child_process"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const scenario = process.argv[2]
const inbox = []
let wake
const prompts = (async function* () {
  for (;;) {
    while (inbox.length) yield inbox.shift()
    await new Promise((resolve) => (wake = resolve))
  }
})()
const send = (text, priority) => {
  inbox.push({
    type: "user",
    message: { role: "user", content: text },
    parent_tool_use_id: null,
    ...(priority ? { priority } : {}),
  })
  wake?.()
}
const t0 = Date.now()
const log = (...args) => console.log(`${String(Date.now() - t0).padStart(6)}ms`, ...args)

let steered = false
const steer = () => {
  if (steered) return
  steered = true
  log(">>> steer (priority now): reply BETA")
  send("Ignore the previous request. Reply with exactly the single word BETA and nothing else.", "now")
}

const firstPrompt =
  scenario !== "after-generation"
    ? "Count from 1 to 300, one number per line, no other text."
    : "Reply with exactly the single word ALPHA and nothing else."

const q = query({
  prompt: prompts,
  options: {
    cwd: mkdtempSync(join(tmpdir(), "claude-probe-")),
    model: "claude-haiku-5-5",
    settingSources: [],
    includePartialMessages: true,
    pathToClaudeCodeExecutable: execFileSync("which", ["claude"], { encoding: "utf8" }).trim(),
    hooks: {
      Stop: [
        {
          hooks: [
            async () => {
              log("Stop hook started, holding 1 s")
              if (scenario === "after-generation") steer()
              await new Promise((r) => setTimeout(r, 1000))
              log("Stop hook done")
              return {}
            },
          ],
        },
      ],
    },
  },
})

send(firstPrompt)
let results = 0
let deltas = 0
const timer = setTimeout(() => (log("quiet for 25 s, stopping"), q.close(), process.exit(0)), 25_000)
for await (const m of q) {
  timer.refresh()
  if (m.type === "stream_event") {
    if (++deltas === 5 && scenario !== "after-generation" && !steered) {
      steer()
      if (scenario === "two-steers") {
        log(">>> steer 2 (priority now): reply GAMMA")
        send("Also ignore that. Reply with exactly the single word GAMMA and nothing else.", "now")
      }
      if (scenario === "interrupt-queued") {
        log(">>> interrupt")
        q.interrupt()
      }
    }
    continue
  }
  if (m.type === "assistant") {
    const text = m.message.content
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("")
      .slice(0, 60)
    log("assistant", JSON.stringify(text))
  } else if (m.type === "result") {
    results++
    log(
      `RESULT #${results}`,
      m.subtype,
      "terminal_reason=" + m.terminal_reason,
      JSON.stringify(String(m.result ?? "").slice(0, 40)),
    )
    if (results >= 4) break
  } else if (m.type === "user") {
    log(
      "user echo",
      JSON.stringify(typeof m.message.content === "string" ? m.message.content.slice(0, 40) : "[blocks]"),
    )
  } else if (m.type === "system") {
    if (m.subtype !== "init") log("system", m.subtype)
  }
}
clearTimeout(timer)
q.close()
process.exit(0)
