import { appendFileSync } from "node:fs"
import { createInterface } from "node:readline"

type Command = { id?: string; type: string; message?: string; value?: string; confirmed?: boolean; cancelled?: true }

const logPath = process.env["FAKE_PI_LOG"]
const log = (record: object) => {
  if (logPath !== undefined) appendFileSync(logPath, `${JSON.stringify(record)}\n`)
}

const argv = process.argv.slice(2)
const flag = (name: string) => {
  const index = argv.indexOf(name)
  return index === -1 ? undefined : argv[index + 1]
}

log({
  kind: "start",
  argv,
  cwd: process.cwd(),
  env: {
    HINACODE_MCP_URL: process.env["HINACODE_MCP_URL"],
    HINACODE_MCP_AUTHORIZATION: process.env["HINACODE_MCP_AUTHORIZATION"],
    TMPDIR: process.env["TMPDIR"],
  },
})

const session = flag("--session")
if (session === "ses_missing") {
  process.stderr.write(`No session found matching '${session}'\n`)
  process.exit(1)
}
if (session === "ses_elsewhere") {
  process.stdout.write("Session found in different project: /elsewhere\nFork this session into current directory? [y/N] ")
  process.stdout.write("Aborted.\n")
  process.exit(0)
}

const send = (message: object, ending = "\n") => process.stdout.write(`${JSON.stringify(message)}${ending}`)

const zeroUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } }

const assistant = (fields: object) => ({
  role: "assistant",
  content: [],
  provider: "fake",
  model: "fake-model",
  usage: zeroUsage,
  stopReason: "stop",
  ...fields,
})

const delta = (type: string, text: string) =>
  send({ type: "message_update", assistantMessageEvent: { type, contentIndex: 0, delta: text } })

const endMessage = (fields: object) => send({ type: "message_end", message: assistant(fields) })

const usage = (input: number, output: number, cost: number) => ({
  input,
  output,
  cacheRead: 100,
  cacheWrite: 5,
  totalTokens: input + output + 105,
  cost: { total: cost },
})

const settle = (aborted = false) => {
  send({ type: "agent_end", messages: [], willRetry: false })
  send({ type: "agent_settled", aborted })
}

const uiAnswers = new Map<string, (answer: Command) => void>()
let nextUi = 0
const ask = (request: object) =>
  new Promise<Command>((resolve) => {
    const id = `ui-${nextUi++}`
    uiAnswers.set(id, resolve)
    send({ type: "extension_ui_request", id, ...request })
  })

let onAbort: (() => void) | undefined
let onSteer: ((message: string) => void) | undefined

const tools: Record<string, { name: string; args: object; details?: object }> = {
  edit: {
    name: "edit",
    args: { path: "a.txt", edits: [{ oldText: "hello", newText: "goodbye" }] },
    details: { diff: "-1 hello\n+1 goodbye", patch: "--- a.txt\n+++ a.txt\n@@ -1 +1 @@\n-hello\n+goodbye\n" },
  },
  bash: { name: "bash", args: { command: "rm -rf build" } },
  read: { name: "read", args: { path: "a.txt" } },
}

const runTool = async (key: string) => {
  const tool = tools[key]!
  const toolCallId = `call_${key}`
  const toolCall = { type: "toolCall", id: toolCallId, name: tool.name, arguments: tool.args }
  send({ type: "message_update", assistantMessageEvent: { type: "toolcall_end", contentIndex: 0, toolCall } })
  endMessage({ content: [toolCall], stopReason: "toolUse", usage: usage(10, 3, 0.01) })
  send({ type: "tool_execution_start", toolCallId, toolName: tool.name, args: tool.args })
  const answer = await ask({ method: "select", title: `hinacode:approve ${toolCallId}`, options: ["allow", "deny"] })
  const allowed = answer.value === "allow"
  send({
    type: "tool_execution_end",
    toolCallId,
    toolName: tool.name,
    result: allowed
      ? { content: [{ type: "text", text: `${tool.name} ok` }], ...(tool.details && { details: tool.details }) }
      : { content: [{ type: "text", text: "The user denied this tool call" }] },
    isError: !allowed,
  })
  delta("text_delta", "done")
  endMessage({ usage: usage(20, 4, 0.02) })
  settle()
}

const prompt = async (text: string) => {
  send({ type: "agent_start" })
  send({ type: "turn_start" })
  send({ type: "message_start", message: { role: "user", content: [{ type: "text", text }] } })
  send({ type: "message_start", message: assistant({ stopReason: "pending" }) })
  if (text in tools) return runTool(text)
  if (text === "ask") {
    const color = await ask({ method: "select", title: "Pick a color", options: ["red", "blue"] })
    const confirmed = await ask({ method: "confirm", title: "Paint it?", message: "This repaints the wall." })
    send({ type: "extension_ui_request", id: "notify-1", method: "notify", message: "painting" })
    delta("text_delta", `picked ${color.value}, confirmed ${confirmed.confirmed}`)
    endMessage({})
    return settle()
  }
  if (text === "hold") {
    send({ type: "tool_execution_start", toolCallId: "call_sleep", toolName: "bash", args: { command: "sleep 60" } })
    await new Promise<void>((resolve) => (onAbort = resolve))
    endMessage({ stopReason: "aborted" })
    return settle(true)
  }
  if (text === "steer") {
    delta("text_delta", "waiting")
    const steered = await new Promise<string>((resolve) => (onSteer = resolve))
    send({ type: "message_start", message: { role: "user", content: [{ type: "text", text: steered }] } })
    delta("text_delta", ` steered: ${steered}`)
    endMessage({})
    return settle()
  }
  if (text === "error" || text === "overloaded") {
    const errorMessage =
      text === "error"
        ? "OAuth refresh failed for anthropic: invalid_grant\n    at refreshAnthropicToken (pi:1:1)"
        : "529 overloaded_error: Overloaded"
    endMessage({ stopReason: "error", errorMessage })
    return settle()
  }
  if (text === "crash") {
    send({ type: "tool_execution_start", toolCallId: "call_build", toolName: "bash", args: { command: "pnpm build" } })
    process.stderr.write("fatal: out of memory\n")
    process.exit(3)
  }
  if (text === "tmp") {
    delta("text_delta", `${process.env["TMPDIR"]}`)
    endMessage({})
    return settle()
  }
  delta("thinking_delta", "Thinking")
  process.stdout.write("pi v1.5.2 ready\n")
  delta("text_delta", `echo: ${text}`)
  send(
    { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: " end" } },
    "\r\n",
  )
  endMessage({ usage: usage(10, 3, 0.01) })
  settle()
}

const models = [
  { id: "plain", name: "Plain", provider: "fake", reasoning: false, contextWindow: 1000 },
  { id: "fake-model", name: "Fake Model", provider: "fake", reasoning: true, contextWindow: 200000 },
]

const handle = (command: Command) => {
  log({ kind: "in", command })
  const respond = (data?: object) =>
    send({ id: command.id, type: "response", command: command.type, success: true, data })
  switch (command.type) {
    case "get_state":
      return respond({
        sessionId: session ?? "ses_new",
        sessionFile: "/fake/session.jsonl",
        model: models[1],
        thinkingLevel: "medium",
        isStreaming: false,
      })
    case "get_available_models":
      return respond({ models })
    case "get_commands":
      return respond({
        commands: [
          { name: "review", description: "Review the diff", source: "prompt", sourceInfo: {} },
          { name: "skill:docs", source: "skill", sourceInfo: {} },
        ],
      })
    case "prompt":
      respond({ disposition: "started" })
      return void prompt(command.message ?? "")
    case "steer":
      respond({ disposition: "queued" })
      return onSteer?.(command.message ?? "")
    case "abort":
      respond()
      return onAbort?.()
    case "clear_queue":
      return respond({ steering: [], followUp: [] })
    case "extension_ui_response":
      uiAnswers.get(command.id ?? "")?.(command)
      return uiAnswers.delete(command.id ?? "")
    default:
      send({ id: command.id, type: "response", command: command.type, success: false, error: "Unknown command" })
  }
}

createInterface({ input: process.stdin })
  .on("line", (line) => handle(JSON.parse(line)))
  .on("close", () => process.exit(0))
