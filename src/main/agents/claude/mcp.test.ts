import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import { expect, test } from "@effect/vitest"
import { type McpServerConfig, query } from "@anthropic-ai/claude-agent-sdk"
import { hinacodeMcpServer } from "./mcp.ts"

/** What the SDK hands the CLI: its argv and what it writes to stdin at startup. No CLI is started. */
const cliInput = async (mcpServers: Record<string, McpServerConfig>) => {
  const abort = new AbortController()
  let args: ReadonlyArray<string> = []
  let stdin = ""
  // The SDK writes its MCP configuration to stdin right after spawning; that write is the signal to stop.
  const { promise: configured, resolve } = Promise.withResolvers<void>()
  const handle = query({
    prompt: (async function* () {})(),
    options: {
      mcpServers,
      abortController: abort,
      spawnClaudeCodeProcess: (options) => {
        args = options.args
        const input = new PassThrough().on("data", (chunk) => {
          stdin += chunk
          if (stdin.includes('"hinacode"')) resolve()
        })
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
  await configured
  abort.abort()
  return { args, stdin }
}

test("the hinacode MCP credential reaches neither the Claude CLI's argv nor its stdin", async () => {
  const secret = "fixture-secret-0123456789"
  const connection = { url: "http://127.0.0.1:1/mcp", headers: { authorization: `Bearer thread-a.${secret}` } }
  const { args, stdin } = await cliInput({ hinacode: hinacodeMcpServer(connection) })
  expect(stdin).toMatch(/"hinacode"/)
  expect(args.some((arg) => arg.includes(secret))).toBe(false)
  expect(stdin.includes(secret)).toBe(false)
})
