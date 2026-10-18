// Usage: node specs/probes/claude-background.mjs <wait|interrupt>
// Claude launches a background sub-agent and ends its reply. `wait` lets the sub-agent finish; `interrupt`
// interrupts while it runs. Prints what the CLI streams after the reply's result. Each run makes a few Haiku
// requests.
import { query } from "@anthropic-ai/claude-agent-sdk"
import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const scenario = process.argv[2]
if (scenario !== "wait" && scenario !== "interrupt") throw new Error("Usage: claude-background.mjs <wait|interrupt>")

const t0 = Date.now()
const log = (...args) => console.log(`${String(Date.now() - t0).padStart(6)}ms`, ...args)
const answers = (m) => {
  const uuids = m.user_message_uuids ?? (m.user_message_uuid === undefined ? [] : [m.user_message_uuid])
  return uuids.length === 0 ? " answers=none" : ` answers=${uuids.join(",")}`
}

const prompt = {
  uuid: randomUUID(),
  type: "user",
  message: {
    role: "user",
    content:
      "Use the Agent tool exactly once with run_in_background: true, description 'sleeper', and prompt " +
      "'Run the Bash command `sleep 15 && echo done`, then reply with the word DONE.' " +
      "Right after launching it, reply with exactly the word WAITING. Do not wait for it.",
  },
  parent_tool_use_id: null,
}
log(">>> prompt", prompt.uuid)

const q = query({
  prompt: (async function* () {
    yield prompt
    await new Promise(() => undefined)
  })(),
  options: {
    cwd: mkdtempSync(join(tmpdir(), "claude-probe-")),
    model: "claude-haiku-5-5",
    settingSources: [],
    includePartialMessages: true,
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    env: { ...process.env, CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: "1" },
    pathToClaudeCodeExecutable: execFileSync("which", ["claude"], { encoding: "utf8" }).trim(),
  },
})

let results = 0
for await (const m of q) {
  if (m.type === "stream_event") {
    if (m.event.type === "message_start" && m.parent_tool_use_id === null) log("response starts" + answers(m))
  } else if (m.type === "assistant" && m.parent_tool_use_id !== null) {
    log("sub-agent", m.message.content.map((block) => block.type).join(","))
  } else if (m.type === "system" && m.subtype === "session_state_changed") {
    log("state", m.state)
    if (m.state === "idle") break
  } else if (m.type === "system" && m.subtype.startsWith("task_")) {
    log(m.subtype, m.task_id, m.status ?? m.patch?.status ?? "")
  } else if (m.type === "result") {
    log("result", m.subtype + answers(m))
    if (++results === 1 && scenario === "interrupt") {
      setTimeout(() => {
        log(">>> interrupt")
        q.interrupt()
      }, 3000)
    }
  }
}
process.exit(0)
