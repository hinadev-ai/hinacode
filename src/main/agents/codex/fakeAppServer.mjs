import { appendFileSync, readFileSync, watch } from "node:fs"
import { basename } from "node:path"
import { createInterface } from "node:readline"

let lastControl = {}
const control = () => {
  try {
    lastControl = JSON.parse(readFileSync(process.env.FAKE_CODEX_CONTROL, "utf8"))
  } catch {}
  return lastControl
}
const send = (message) => {
  if (control().noise) process.stdout.write('WARN codex_core: config.toml has an unknown key\n{"id": \n')
  process.stdout.write(`${JSON.stringify(message)}\n`)
}
const crash = (code) => {
  process.stderr.write("thread 'main' panicked at codex-rs/app-server/src/lib.rs: boom\n")
  process.exit(code)
}
const turnCompleted = (threadId, turnId, status) => ({
  method: "turn/completed",
  params: { threadId, turn: { id: turnId, status, error: null } },
})
const completeTurn = (threadId, turnId, status) => send(turnCompleted(threadId, turnId, status))
const sendInOneWrite = (messages) =>
  process.stdout.write(messages.map((message) => `${JSON.stringify(message)}\n`).join(""))

const sandboxPolicy = (mode) =>
  mode === "danger-full-access"
    ? { type: "dangerFullAccess" }
    : {
        type: "workspaceWrite",
        writableRoots: [],
        networkAccess: false,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      }

const breakdown = (inputTokens, outputTokens) => ({
  totalTokens: inputTokens + outputTokens,
  inputTokens,
  cachedInputTokens: 0,
  outputTokens,
  reasoningOutputTokens: 0,
})
const turnTokenUsage = [
  { total: breakdown(1000, 50), last: breakdown(1000, 50), modelContextWindow: 258400 },
  { total: breakdown(3200, 80), last: breakdown(2200, 30), modelContextWindow: 258400 },
]

const spawnSubagent = (threadId, turnId) => {
  const child = "codex-child-thread"
  const item = (method, params) => send({ method, params: { threadId, turnId, ...params } })
  const childItem = (method, params) => send({ method, params: { threadId: child, turnId: "child-turn", ...params } })
  const activity = {
    type: "subAgentActivity",
    id: "spawn",
    kind: "started",
    agentThreadId: child,
    agentPath: "/root/count",
  }
  const command = { type: "commandExecution", id: "child-exec", command: "wc -l", cwd: "/repo", exitCode: null }
  item("item/started", { item: activity })
  if (control().subagentPending) {
    return send({ method: "turn/started", params: { threadId: child, turn: { id: "child-turn" } } })
  }
  childItem("item/started", { item: { ...command, status: "inProgress", aggregatedOutput: null } })
  childItem("item/commandExecution/outputDelta", { itemId: "child-exec", delta: "218\n" })
  childItem("item/completed", { item: { ...command, status: "completed", aggregatedOutput: null, exitCode: 0 } })
}

const subagentFinishMessages = () => {
  const child = "codex-child-thread"
  const message = { type: "agentMessage", id: "child-reply", text: "218 lines" }
  return [
    { method: "item/completed", params: { threadId: child, turnId: "child-turn", item: message } },
    turnCompleted(child, "child-turn", "completed"),
  ]
}

let subagentFinishSent = false
const held = []
const terminals = new Map()
const loadedSandboxes = new Map()
let turns = 0
let activeRequest = null

const reply = ({ id, method, params }) => {
  if (method === undefined) {
    if (id === activeRequest?.id) {
      completeTurn(activeRequest.threadId, activeRequest.turnId, "completed")
      activeRequest = null
    }
    return
  }
  switch (method) {
    case "account/read": {
      const { accountResponse, accountFromHome } = control()
      const home = process.env.CODEX_HOME
      if (accountFromHome && home) {
        const email = `${basename(home)}@example.com`
        return send({ id, result: { account: { type: "chatgpt", email, planType: "pro" }, requiresOpenaiAuth: true } })
      }
      return send({ id, result: accountResponse ?? { account: null, requiresOpenaiAuth: true } })
    }
    case "account/rateLimits/read":
      return send({ id, result: control().rateLimitsResponse ?? {} })
    case "model/list":
      return send({
        id,
        result: {
          data: [
            {
              id: "gpt-6.1-sol",
              displayName: "GPT-6.1 Sol",
              supportedReasoningEfforts: [],
              defaultReasoningEffort: "low",
              serviceTiers: [],
            },
          ],
          nextCursor: null,
        },
      })
    case "skills/list":
      return control().skillsFail
        ? send({ id, error: { code: -32603, message: "skills could not be listed" } })
        : send({ id, result: { data: control().skills ?? [] } })
    case "thread/list":
      return send({ id, result: control().sessions?.list ?? { data: [], nextCursor: null } })
    case "thread/read": {
      const read = control().sessions?.read
      return read?.thread.id === params.threadId
        ? send({ id, result: read })
        : send({ id, error: { code: -32600, message: `thread not loaded: ${params.threadId}` } })
    }
    case "thread/turns/list": {
      const pages = control().sessions?.turnPages ?? []
      const index = params.cursor ? pages.findIndex((page) => page.nextCursor === params.cursor) + 1 : 0
      return send({ id, result: pages[index] ?? { data: [], nextCursor: null } })
    }
    case "thread/start":
      loadedSandboxes.set("codex-thread", sandboxPolicy(params.sandbox))
      return send({ id, result: { thread: { id: "codex-thread" }, sandbox: loadedSandboxes.get("codex-thread") } })
    case "thread/resume":
      if (!loadedSandboxes.has("codex-thread")) loadedSandboxes.set("codex-thread", sandboxPolicy(params.sandbox))
      return send({ id, result: { thread: { id: "codex-thread" }, sandbox: loadedSandboxes.get("codex-thread") } })
    case "thread/inject_items":
      return send({ id, result: {} })
    case "thread/unsubscribe":
      loadedSandboxes.delete(params.threadId)
      return send({ id, result: {} })
    case "thread/fork":
      return send({ id, result: { thread: { id: "codex-fork" }, sandbox: sandboxPolicy(params.sandbox) } })
    case "turn/start": {
      const turnId = `turn-${++turns}`
      if (params.sandboxPolicy) loadedSandboxes.set(params.threadId, params.sandboxPolicy)
      send({ id, result: { turn: { id: turnId } } })
      const { question, postedQuestions, unauthorized, crashMidTurn } = control()
      if (crashMidTurn) {
        send({
          method: "item/agentMessage/delta",
          params: { threadId: params.threadId, turnId, itemId: "m", delta: "half" },
        })
        return crash(101)
      }
      if (unauthorized) {
        const error = { message: "Your access token could not be refreshed", codexErrorInfo: "unauthorized" }
        send({ method: "error", params: { threadId: params.threadId, turnId, willRetry: false, error } })
        return completeTurn(params.threadId, turnId, "failed")
      }
      if (question) {
        activeRequest = { id: 900 + turns, threadId: params.threadId, turnId }
        return send({
          id: activeRequest.id,
          method: "item/tool/requestUserInput",
          params: { threadId: params.threadId, turnId, itemId: "question-tool", questions: question },
        })
      }
      if (control().mcpToolApproval) {
        activeRequest = { id: 950 + turns, threadId: params.threadId, turnId }
        return send({
          id: activeRequest.id,
          method: "mcpServer/elicitation/request",
          params: {
            threadId: params.threadId,
            turnId,
            serverName: "linear",
            message: "Allow linear to run create_issue?",
            _meta: { codex_approval_kind: "mcp_tool_call" },
          },
        })
      }
      if (postedQuestions) {
        send({
          method: "item/completed",
          params: {
            threadId: params.threadId,
            turnId,
            item: { id: "posted", type: "agentMessage", text: "Posted question", questions: postedQuestions },
          },
        })
      }
      if (control().plan) {
        send({
          method: "turn/plan/updated",
          params: {
            threadId: params.threadId,
            turnId,
            explanation: "Two steps",
            plan: [
              { step: "Read the code", status: "completed" },
              { step: "Write the fix", status: "inProgress" },
            ],
          },
        })
      }
      if (control().compaction) {
        for (const event of ["item/started", "item/completed"]) {
          send({
            method: event,
            params: { threadId: params.threadId, turnId, item: { type: "contextCompaction", id: "c1" } },
          })
        }
      }
      if (control().subagent) spawnSubagent(params.threadId, turnId)
      if (control().backgroundTerminal) {
        const item = {
          type: "commandExecution",
          id: "dev-server",
          command: "pnpm dev",
          cwd: "/repo",
          processId: "1001",
          status: "inProgress",
          aggregatedOutput: null,
          exitCode: null,
        }
        terminals.set(params.threadId, [{ itemId: item.id, processId: item.processId, command: item.command }])
        send({ method: "item/started", params: { threadId: params.threadId, turnId, item } })
      }
      if (control().subagentEndsWithTurn) {
        subagentFinishSent = true
        return sendInOneWrite([turnCompleted(params.threadId, turnId, "completed"), ...subagentFinishMessages()])
      }
      if (!control().holdTurn) {
        for (const tokenUsage of turnTokenUsage) {
          send({ method: "thread/tokenUsage/updated", params: { threadId: params.threadId, turnId, tokenUsage } })
        }
        return completeTurn(params.threadId, turnId, "completed")
      }
      return send({
        method: "item/agentMessage/delta",
        params: { threadId: params.threadId, turnId, itemId: "message", delta: "working" },
      })
    }
    case "thread/backgroundTerminals/list": {
      const data = (terminals.get(params.threadId) ?? []).map((terminal) => ({
        ...terminal,
        cwd: "/repo",
        osPid: 4242,
        cpuPercent: 0.5,
        rssKb: 1024,
      }))
      return send({ id, result: { data, nextCursor: null } })
    }
    case "thread/backgroundTerminals/terminate": {
      const running = terminals.get(params.threadId) ?? []
      const rest = running.filter((terminal) => terminal.processId !== params.processId)
      terminals.set(params.threadId, rest)
      return send({ id, result: { terminated: rest.length < running.length } })
    }
    case "thread/compact/start": {
      const turnId = `turn-${++turns}`
      send({ id, result: {} })
      send({ method: "turn/started", params: { threadId: params.threadId, turn: { id: turnId } } })
      for (const event of ["item/started", "item/completed"]) {
        send({
          method: event,
          params: { threadId: params.threadId, turnId, item: { type: "contextCompaction", id: "c1" } },
        })
      }
      return completeTurn(params.threadId, turnId, "completed")
    }
    case "turn/interrupt":
      activeRequest = null
      send({ id, result: {} })
      return completeTurn(params.threadId, params.turnId, "interrupted")
    default:
      return send({ id, result: {} })
  }
}

createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line)
  appendFileSync(process.env.FAKE_CODEX_LOG, `${line}\n`)
  if (message.id === undefined) return
  const { stall, release, crashOn } = control()
  if (crashOn !== undefined && crashOn === message.method) return crash(1)
  if (stall?.includes(message.method) && !release) held.push(message)
  else reply(message)
})

watch(process.env.FAKE_CODEX_CONTROL, () => {
  if (activeRequest && control().cancelQuestion) {
    send({
      method: "serverRequest/resolved",
      params: { threadId: activeRequest.threadId, requestId: activeRequest.id },
    })
    completeTurn(activeRequest.threadId, activeRequest.turnId, "completed")
    activeRequest = null
  }
  if (held.length > 0 && control().release) held.splice(0).forEach(reply)
  if (control().finishSubagent && !subagentFinishSent) {
    subagentFinishSent = true
    subagentFinishMessages().forEach(send)
  }
})
