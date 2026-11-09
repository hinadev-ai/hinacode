import { appendFileSync, readFileSync } from "node:fs"
import { connect } from "node:net"
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
const silentInitialize = process.env["FAKE_ACP_SILENT_INITIALIZE"] === "1"
const lifeline = process.env["FAKE_ACP_LIFELINE"]
if (lifeline !== undefined) connect(lifeline).on("error", () => {})

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

const createdSessions = () =>
  logPath === undefined
    ? 1
    : readFileSync(logPath, "utf8")
        .split("\n")
        .filter((line) => line.includes('"method":"session/new"')).length

const efforts: Record<string, Array<string>> = { "fake/other": ["low", "high", "default"] }
const current = new Map<string, { model: string; effort: string }>()

const configFor = (sessionId: string) => {
  const { model, effort } = current.get(sessionId) ?? { model: "fake/default", effort: "default" }
  const levels = efforts[model]
  return [
    {
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: model,
      options: [
        { value: "fake/other", name: "Fake Other" },
        { value: "fake/default", name: "Fake Default" },
      ],
    },
    ...(levels === undefined
      ? []
      : [
          {
            id: "effort",
            name: "Effort",
            category: "thought_level",
            type: "select",
            currentValue: effort,
            options: levels.map((value) => ({ value, name: value })),
          },
        ]),
  ]
}

const modelSetup = (sessionId: string) =>
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
    : { configOptions: configFor(sessionId) }

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
  if (text === "crash") {
    update(sessionId, {
      sessionUpdate: "tool_call",
      toolCallId: "call_build",
      title: "bash",
      kind: "execute",
      status: "in_progress",
      rawInput: { command: "pnpm build" },
    })
    process.stderr.write("fatal: out of memory\n")
    process.exit(3)
  }
  if (text === "noise") {
    process.stdout.write("opencode v9 starting\n{not json\n")
    send({ method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk" } } })
  }
  if (text === "malformed") return send({ id: message.id, result: { stopReason: 42 } })
  if (text === "ask") {
    let cancelled = false
    cancels.set(sessionId, () => void (cancelled = true))
    await writeTool(sessionId, "/fake")
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
      if (silentInitialize) return
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
    case "session/new": {
      if (authRequired) {
        return send({
          id: message.id,
          error: {
            code: -32000,
            message: "Authentication required",
            data: { message: "Run 'opencode auth login' first." },
          },
        })
      }
      const sessionId = `ses_${createdSessions()}`
      send({ id: message.id, result: { sessionId, ...modelSetup(sessionId) } })
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
      return send({ id: message.id, result: modelSetup(sessionId) })
    }
    case "session/set_config_option": {
      const sessionId = params["sessionId"] as string
      const selected = current.get(sessionId) ?? { model: "fake/default", effort: "default" }
      current.set(
        sessionId,
        params["configId"] === "model"
          ? { model: params["value"] as string, effort: "default" }
          : { ...selected, effort: params["value"] as string },
      )
      return send({ id: message.id, result: { configOptions: configFor(sessionId) } })
    }
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
