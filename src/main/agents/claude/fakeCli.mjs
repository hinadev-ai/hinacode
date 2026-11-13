import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { connect } from "node:net"
import { join } from "node:path"
import { createInterface } from "node:readline"

const home = process.env.CLAUDE_CONFIG_DIR
const control = () => {
  try {
    return JSON.parse(readFileSync(join(home, "control.json"), "utf8"))
  } catch {
    return {}
  }
}
const { lifeline, exitOnStart, lingerAfterLostSession, bypassDisabled } = control()
if (lifeline !== undefined) connect(lifeline).on("error", () => {})
process.stdin.on("end", () => process.exit(0))

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`)
const die = (code, lastWords) => {
  process.stderr.write(`${lastWords}\n`)
  process.exit(code)
}

if (exitOnStart) die(1, "Error: Claude Code could not read its settings")

writeFileSync(join(home, "argv.json"), JSON.stringify(process.argv.slice(2)))
const sessions = join(home, "sessions")
mkdirSync(sessions, { recursive: true })
const resumed = process.argv.find((arg) => arg.startsWith("--resume="))?.slice("--resume=".length) ?? null
const sessionId = resumed ?? randomUUID()
const requestedMode =
  process.argv.find((arg) => arg.startsWith("--permission-mode="))?.slice("--permission-mode=".length) ?? "default"
const permissionMode = bypassDisabled && requestedMode === "bypassPermissions" ? "default" : requestedMode

const usage = {
  input_tokens: 4,
  output_tokens: 8,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
  service_tier: "standard",
  cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
  inference_geo: "",
  iterations: [],
  speed: "standard",
  fallback_credit: null,
  output_tokens_details: { thinking_tokens: 0 },
}
const result = (fields) =>
  send({
    type: "result",
    duration_ms: 1,
    duration_api_ms: 1,
    num_turns: 1,
    stop_reason: null,
    session_id: sessionId,
    total_cost_usd: 0,
    usage,
    modelUsage: {},
    permission_denials: [],
    uuid: randomUUID(),
    ...fields,
  })

if (resumed !== null && !existsSync(join(sessions, resumed))) {
  result({
    subtype: "error_during_execution",
    is_error: true,
    errors: [`No conversation found with session ID: ${resumed}`],
  })
  if (!lingerAfterLostSession) die(1, `No conversation found with session ID: ${resumed}`)
  // oxlint-disable-next-line hinacode/no-comments
  // Stays alive until a second user prompt arrives, which means the harness reused this lost session.
  let pendingPrompt = 1
  createInterface({ input: process.stdin }).on("line", (line) => {
    let message
    try {
      message = JSON.parse(line)
    } catch {
      return
    }
    if (message.type !== "user") return
    if (pendingPrompt > 0) {
      pendingPrompt--
      return
    }
    writeFileSync(join(home, "reused.txt"), "reused\n")
    process.exit(0)
  })
  await new Promise(() => {})
}
writeFileSync(join(sessions, sessionId), "")

const init = () =>
  send({
    type: "system",
    subtype: "init",
    session_id: sessionId,
    uuid: randomUUID(),
    cwd: process.cwd(),
    tools: [],
    mcp_servers: [],
    model: "claude-sonnet-5-5",
    permissionMode,
    slash_commands: [],
    apiKeySource: "none",
    output_style: "default",
  })
const textDelta = (text) =>
  send({
    type: "stream_event",
    event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    parent_tool_use_id: null,
    session_id: sessionId,
    uuid: randomUUID(),
  })

const reply = (text) => {
  textDelta(text)
  send({
    type: "assistant",
    parent_tool_use_id: null,
    session_id: sessionId,
    uuid: randomUUID(),
    message: {
      id: `msg_${randomUUID()}`,
      type: "message",
      role: "assistant",
      model: "claude-sonnet-5-5",
      content: [{ type: "text", text }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage,
    },
  })
  result({ subtype: "success", is_error: false, result: text })
}
const pendingTools = new Map()
let interrupted = null

let initAfterModeSwitch = null

const prompt = (text) => {
  if (text === "init after a mode switch") {
    textDelta("waiting for a mode switch")
    initAfterModeSwitch = () => {
      init()
      reply("started in the launch mode")
    }
    return
  }
  init()
  if (text === "exit") return process.exit(0)
  if (text === "crash") {
    textDelta("half an answer")
    return die(3, "FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory")
  }
  if (text === "crash with a late stderr line") {
    spawn("sh", ["-c", "sleep 0.05; echo 'late stderr line' >&2"], { stdio: ["ignore", "ignore", "inherit"] })
    return die(3, "FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory")
  }
  if (text === "noise") {
    process.stdout.write("Claude Code is starting\n")
    send({ type: "brand_new_message", session_id: sessionId, uuid: randomUUID() })
    send({ type: "system", subtype: "brand_new_subtype", session_id: sessionId, uuid: randomUUID() })
  }
  if (text === "lose session on stop") {
    const requestId = randomUUID()
    pendingTools.set(requestId, text)
    interrupted = () => {
      send({ type: "control_cancel_request", request_id: requestId })
      pendingTools.delete(requestId)
      result({
        subtype: "error_during_execution",
        is_error: true,
        errors: [`No conversation found with session ID: ${sessionId}`],
      })
    }
    send({
      type: "control_request",
      request_id: requestId,
      request: {
        subtype: "can_use_tool",
        tool_name: "Bash",
        input: { command: "ls" },
        tool_use_id: `toolu_${requestId}`,
      },
    })
    return
  }
  if (text === "approve" || text === "approve then crash") {
    const requestId = randomUUID()
    pendingTools.set(requestId, text)
    interrupted = () => {
      send({ type: "control_cancel_request", request_id: requestId })
      pendingTools.delete(requestId)
      result({ subtype: "error_during_execution", is_error: true, errors: [] })
    }
    send({
      type: "control_request",
      request_id: requestId,
      request: {
        subtype: "can_use_tool",
        tool_name: "Bash",
        input: { command: "rm -rf build" },
        tool_use_id: `toolu_${requestId}`,
      },
    })
    if (text === "approve then crash") die(3, "Segmentation fault")
    return
  }
  reply(`echo: ${text}`)
}

const answer = (request_id, response = {}) =>
  send({ type: "control_response", response: { subtype: "success", request_id, response } })

const answerOnceReleased = (request_id, release) => {
  const poll = setInterval(() => {
    if (!existsSync(join(home, release))) return
    clearInterval(poll)
    answer(request_id)
  }, 20)
}

createInterface({ input: process.stdin }).on("line", (line) => {
  appendFileSync(join(home, "received.jsonl"), `${line}\n`)
  const message = JSON.parse(line)
  if (message.type === "control_request") {
    if (message.request.subtype === "initialize")
      return answer(message.request_id, { commands: [], agents: [], output_style: "default", models: [], account: {} })
    if (message.request.subtype === "interrupt") {
      answer(message.request_id)
      interrupted?.()
      interrupted = null
      return
    }
    if (message.request.subtype === "set_model" && control().holdSetModel)
      return answerOnceReleased(message.request_id, "release-set-model")
    answer(message.request_id)
    if (message.request.subtype === "set_permission_mode") initAfterModeSwitch?.()
    initAfterModeSwitch = null
    return
  }
  if (message.type === "control_response") {
    if (!pendingTools.delete(message.response.request_id)) return
    interrupted = null
    return reply("ran the tool")
  }
  if (message.type === "user") {
    const content = message.message.content
    prompt(typeof content === "string" ? content : content.find((block) => block.type === "text")?.text)
  }
})
