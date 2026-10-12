import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import { setTimeout } from "node:timers/promises"
import { expect, test } from "@effect/vitest"
import { type McpServerConfig, query } from "@anthropic-ai/claude-agent-sdk"
import { kkcodeMcpServer } from "./mcp.ts"

/** What the SDK hands the CLI: its argv and what it writes to stdin at startup. No CLI is started. */
const cliInput = async (mcpServers: Record<string, McpServerConfig>) => {
  const abort = new AbortController()
  let args: ReadonlyArray<string> = []
  let stdin = ""
  const handle = query({
    prompt: (async function* () {})(),
    options: {
      mcpServers,
      abortController: abort,
      spawnClaudeCodeProcess: (options) => {
        args = options.args
        const input = new PassThrough().on("data", (chunk) => (stdin += chunk))
        return Object.assign(new EventEmitter(), {
          stdin: input,
          stdout: new PassThrough(),
          killed: false,
          exitCode: null,
          kill: () => true,
        })
      },
    },
  })
  handle.next().catch(() => undefined)
  await setTimeout(100)
  abort.abort()
  return { args, stdin }
}

test("the kkcode MCP credential reaches neither the Claude CLI's argv nor its stdin", async () => {
  const secret = "fixture-secret-0123456789"
  const connection = { url: "http://127.0.0.1:1/mcp", headers: { authorization: `Bearer thread-a.${secret}` } }
  const { args, stdin } = await cliInput({ kkcode: kkcodeMcpServer(connection) })
  expect(stdin).toMatch(/"kkcode"/)
  expect(!args.some((arg) => arg.includes(secret))).toBeTruthy()
  expect(!stdin.includes(secret)).toBeTruthy()
})
