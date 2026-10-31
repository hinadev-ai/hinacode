import { appendFileSync } from "node:fs"
import { createInterface } from "node:readline"

type Id = number | string
type Message = {
  id?: Id
  method?: string
  params?: Record<string, unknown>
  result?: unknown
  error?: unknown
}

const logPath = process.env["FAKE_ACP_LOG"]
const legacyModels = process.env["FAKE_ACP_MODELS"] === "legacy"
const authRequired = process.env["FAKE_ACP_AUTH"] === "required"

const send = (message: object) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`)
const update = (sessionId: string, body: object) =>
  send({ method: "session/update", params: { sessionId, update: body } })

const waiting = new Map<Id, (message: Message) => void>()
let nextId = 0
const ask = (method: string, params: object) =>
  new Promise<Message>((resolve) => {
    const id = nextId++
    waiting.set(id, resolve)
    send({ id, method, params })
  })

const cancels = new Map<string, () => void>()
let sessions = 0
let authenticated = false

const modelSetup = () =>
  legacyModels
    ? {
        models: {
          currentModelId: "legacy-default",
          availableModels: [
            { modelId: "legacy-other", name: "Legacy Other" },
            { modelId: "legacy-default", name: "Legacy Default" },
          ],
        },
      }
    : {
        configOptions: [
          {
            id: "model",
            name: "Model",
            category: "model",
            type: "select",
            currentValue: "fake/default",
            options: [
              { value: "fake/other", name: "Fake Other" },
              { value: "fake/default", name: "Fake Default" },
            ],
          },
        ],
      }

const writeTool = async (sessionId: string, cwd: string) => {
  const path = `${cwd}/hello.txt`
  const toolCallId = "call_write"
  update(sessionId, {
    sessionUpdate: "tool_call",
    toolCallId,
    title: "write",
    kind: "edit",
    status: "pending",
    rawInput: {},
  })
  update(sessionId, {
    sessionUpdate: "tool_call_update",
    toolCallId,
    status: "in_progress",
    kind: "edit",
    title: "write",
    locations: [{ path }],
    rawInput: { filePath: path, content: "hi" },
  })
  const fsAnswer = await ask("fs/write_text_file", { sessionId, path, content: "hi" })
  appendFileSync(logPath ?? "/dev/null", `${JSON.stringify({ answered: "fs/write_text_file", ...fsAnswer })}\n`)
  const permission = await ask("session/request_permission", {
    sessionId,
    toolCall: {
      toolCallId,
      title: path,
      kind: "edit",
      status: "pending",
      locations: [{ path }],
      rawInput: { filepath: path, diff: `--- ${path}\n+++ ${path}\n+hi\n` },
      content: [{ type: "diff", path, oldText: "", newText: "hi" }],
    },
    options: [
      { optionId: "once", kind: "allow_once", name: "Allow once" },
      { optionId: "always", kind: "allow_always", name: "Always allow" },
      { optionId: "reject", kind: "reject_once", name: "Reject" },
    ],
  })
  const outcome = (permission.result as { outcome: { outcome: string; optionId?: string } }).outcome
  if (outcome.outcome === "cancelled") return
  const allowed = outcome.outcome === "selected" && outcome.optionId !== "reject"
  update(sessionId, {
    sessionUpdate: "tool_call_update",
    toolCallId,
    status: allowed ? "completed" : "failed",
    title: "hello.txt",
    content: [{ type: "content", content: { type: "text", text: allowed ? "Wrote file successfully." : "Rejected" } }],
  })
}

const prompt = async (message: Message) => {
  const params = message.params as { sessionId: string; prompt: Array<{ type: string; text?: string }> }
  const { sessionId } = params
  const text = params.prompt.findLast((block) => block.type === "text")?.text ?? ""
  if (text === "hold") {
    update(sessionId, {
      sessionUpdate: "tool_call",
      toolCallId: "call_sleep",
      title: "bash",
      kind: "execute",
      status: "in_progress",
      rawInput: { command: "sleep 60" },
    })
    await new Promise<void>((resolve) => cancels.set(sessionId, resolve))
    return send({ id: message.id, result: { stopReason: "cancelled" } })
  }
  if (text === "ask") {
    let cancelled = false
    const cancel = new Promise<void>((resolve) => cancels.set(sessionId, () => resolve(void (cancelled = true))))
    await Promise.race([writeTool(sessionId, "/fake"), cancel])
    cancels.delete(sessionId)
    if (cancelled) return send({ id: message.id, result: { stopReason: "cancelled" } })
    update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done" } })
    return send({ id: message.id, result: { stopReason: "end_turn" } })
  }
  update(sessionId, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Thinking" } })
  update(sessionId, { sessionUpdate: "plan", entries: [{ content: "Reply", priority: "high", status: "in_progress" }] })
  update(sessionId, { sessionUpdate: "usage_update", used: 1200, size: 200000 })
  update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `echo: ${text}` } })
  send({ id: message.id, result: { stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 3 } } })
}

const handle = (message: Message) => {
  if (logPath !== undefined) appendFileSync(logPath, `${JSON.stringify(message)}\n`)
  if (message.method === undefined) {
    waiting.get(message.id!)?.(message)
    waiting.delete(message.id!)
    return
  }
  const params = message.params ?? {}
  switch (message.method) {
    case "initialize":
      return send({
        id: message.id,
        result: {
          protocolVersion: 1,
          agentCapabilities: {
            loadSession: true,
            promptCapabilities: { image: true },
            sessionCapabilities: { close: {} },
          },
          authMethods: [],
        },
      })
    case "authenticate":
      authenticated = true
      return send({ id: message.id, result: {} })
    case "session/new": {
      if (authRequired && !authenticated) {
        return send({
          id: message.id,
          error: { code: -32000, message: "Authentication required", data: { message: "Run 'agent login' first." } },
        })
      }
      const sessionId = `ses_${++sessions}`
      send({ id: message.id, result: { sessionId, ...modelSetup() } })
      return update(sessionId, {
        sessionUpdate: "available_commands_update",
        availableCommands: [{ name: "review", description: "Review the diff", input: { hint: "branch" } }],
      })
    }
    case "session/load": {
      const sessionId = params["sessionId"] as string
      if (sessionId === "ses_missing") {
        return send({ id: message.id, error: { code: -32002, message: "Session not found" } })
      }
      update(sessionId, { sessionUpdate: "user_message_chunk", content: { type: "text", text: "old question" } })
      update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "replayed" } })
      return send({ id: message.id, result: modelSetup() })
    }
    case "session/set_config_option":
    case "session/set_model":
    case "session/close":
      return send({ id: message.id, result: {} })
    case "session/prompt":
      return void prompt(message)
    case "session/cancel": {
      const sessionId = params["sessionId"] as string
      const cancel = cancels.get(sessionId)
      cancels.delete(sessionId)
      return cancel?.()
    }
    default:
      if (message.id !== undefined) send({ id: message.id, error: { code: -32601, message: "Method not found" } })
  }
}

createInterface({ input: process.stdin }).on("line", (line) => handle(JSON.parse(line)))
