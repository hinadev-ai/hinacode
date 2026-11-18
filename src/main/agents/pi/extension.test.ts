import { afterEach, describe, expect, it, vi } from "vitest"
import { MCP_TOOL_TIMEOUT_SECONDS } from "../provider.ts"
import hinacode from "./extension.mjs"

type ToolCallHandler = (
  event: { toolCallId: string },
  ctx: { ui: { select: (...args: Array<unknown>) => Promise<string | undefined> }; signal: AbortSignal },
) => Promise<unknown>

type SetStatus = (key: string, text: string) => void

const load = () => {
  const servers: Array<[string, unknown]> = []
  const handlers = new Map<string, Function>()
  hinacode({
    registerMcpServer: (name: string, config: unknown) => servers.push([name, config]),
    on: (event: string, handler: Function) => handlers.set(event, handler),
  })
  return {
    servers,
    onToolCall: handlers.get("tool_call") as ToolCallHandler,
    onSessionStart: handlers.get("session_start") as (event: unknown, ctx: { ui: { setStatus: SetStatus } }) => void,
  }
}

afterEach(() => {
  vi.unstubAllEnvs()
})

describe("the pi extension", () => {
  it("registers HinaCode's MCP server from the environment", () => {
    vi.stubEnv("HINACODE_MCP_URL", "http://127.0.0.1:9/mcp")
    vi.stubEnv("HINACODE_MCP_AUTHORIZATION", "Bearer test")
    const { servers } = load()
    expect(process.env.HINACODE_MCP_URL).toBeUndefined()
    expect(process.env.HINACODE_MCP_AUTHORIZATION).toBeUndefined()
    expect(servers).toStrictEqual([
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

  it("tells HinaCode it loaded once the session starts", () => {
    const setStatus = vi.fn<SetStatus>()
    load().onSessionStart({}, { ui: { setStatus } })
    expect(setStatus).toHaveBeenCalledWith("hinacode", "ready")
  })
})
