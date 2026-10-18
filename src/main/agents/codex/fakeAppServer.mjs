// Stands in for `codex app-server` in tests. Every received message is appended to $FAKE_CODEX_LOG as a JSON line.
// $FAKE_CODEX_CONTROL is a JSON file re-read on every request and whenever it changes:
//   stall: methods to hold without replying, until `release` becomes true
//   holdTurn: keep a started turn running until turn/interrupt instead of completing it right away
//   accountFromHome: account/read reports `<basename of $CODEX_HOME>@example.com`
//   subagent: spawn a sub-agent thread that runs one command before the turn completes
import { appendFileSync, readFileSync, watch } from "node:fs"
import { basename } from "node:path"
import { createInterface } from "node:readline"

const control = () => {
  try {
    return JSON.parse(readFileSync(process.env.FAKE_CODEX_CONTROL, "utf8"))
  } catch {
    // The test is mid-write; the next change event reads the finished file.
    return {}
  }
}
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`)
const completeTurn = (threadId, turnId, status) =>
  send({ method: "turn/completed", params: { threadId, turn: { id: turnId, status, error: null } } })

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
// A completed turn makes two model requests.
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

const held = []
let turns = 0
let activeQuestion = null

const reply = ({ id, method, params }) => {
  if (method === undefined) {
    if (id === activeQuestion?.id) {
      completeTurn(activeQuestion.threadId, activeQuestion.turnId, "completed")
      activeQuestion = null
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
      return send({ id, result: { data: [] } })
    case "thread/start":
    case "thread/resume":
      return send({ id, result: { thread: { id: "codex-thread" }, sandbox: sandboxPolicy(params.sandbox) } })
    case "turn/start": {
      const turnId = `turn-${++turns}`
      send({ id, result: { turn: { id: turnId } } })
      const { question, postedQuestions } = control()
      if (question) {
        activeQuestion = { id: 900 + turns, threadId: params.threadId, turnId }
        return send({
          id: activeQuestion.id,
          method: "item/tool/requestUserInput",
          params: { threadId: params.threadId, turnId, itemId: "question-tool", questions: question },
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
      if (control().subagent) spawnSubagent(params.threadId, turnId)
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
    case "turn/interrupt":
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
  const { stall, release } = control()
  if (stall?.includes(message.method) && !release) held.push(message)
  else reply(message)
})

// Held messages go out when the test flips `release`; the control file changing is the only trigger.
watch(process.env.FAKE_CODEX_CONTROL, () => {
  if (activeQuestion && control().cancelQuestion) {
    send({
      method: "serverRequest/resolved",
      params: { threadId: activeQuestion.threadId, requestId: activeQuestion.id },
    })
    completeTurn(activeQuestion.threadId, activeQuestion.turnId, "completed")
    activeQuestion = null
  }
  if (held.length > 0 && control().release) held.splice(0).forEach(reply)
})
