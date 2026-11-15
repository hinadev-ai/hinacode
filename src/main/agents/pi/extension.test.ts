import { afterEach, describe, expect, it, vi } from "vitest"
import { MCP_TOOL_TIMEOUT_SECONDS } from "../provider.ts"
import hinacode from "./extension.mjs"

type ToolCallHandler = (
  event: { toolCallId: string },
  ctx: { ui: { select: (...args: Array<unknown>) => Promise<string | undefined> }; signal: AbortSignal },
) => Promise<unknown>

const load = () => {
  const servers: Array<[string, unknown]> = []
  const handlers = new Map<string, ToolCallHandler>()
  hinacode({
    registerMcpServer: (name: string, config: unknown) => servers.push([name, config]),
    on: (event: string, handler: ToolCallHandler) => handlers.set(event, handler),
  })
  return { servers, onToolCall: handlers.get("tool_call")! }
}

afterEach(() => {
  vi.unstubAllEnvs()
})

describe("the pi extension", () => {
  it("registers HinaCode's MCP server from the environment", () => {
    vi.stubEnv("HINACODE_MCP_URL", "http://127.0.0.1:9/mcp")
    vi.stubEnv("HINACODE_MCP_AUTHORIZATION", "Bearer test")
    expect(load().servers).toStrictEqual([
      [
        "hinacode",
        {
          url: "http://127.0.0.1:9/mcp",
          headers: { authorization: "Bearer test" },
          timeout: MCP_TOOL_TIMEOUT_SECONDS,
          exposure: "direct",
        },
      ],
    ])
  })

  it("registers no MCP server outside HinaCode", () => {
    vi.stubEnv("HINACODE_MCP_URL", undefined)
    expect(load().servers).toStrictEqual([])
  })

  it("asks HinaCode about each tool call and blocks it unless the answer is allow", async () => {
    const { onToolCall } = load()
    const signal = new AbortController().signal
    const answers = ["allow", "deny", undefined]
    const select = vi.fn(async () => answers.shift())
    const ctx = { ui: { select }, signal }

    expect(await onToolCall({ toolCallId: "c1" }, ctx)).toBeUndefined()
    expect(await onToolCall({ toolCallId: "c2" }, ctx)).toStrictEqual({
      block: true,
      reason: "The user denied this tool call",
    })
    expect(await onToolCall({ toolCallId: "c3" }, ctx)).toStrictEqual({
      block: true,
      reason: "The user denied this tool call",
    })
    expect(select).toHaveBeenNthCalledWith(1, "hinacode:approve c1", ["allow", "deny"], { signal })
  })
})
