import { Context } from "effect"

/**
 * Streamable HTTP URL of the built-in kkcode MCP server. The server is not running yet, so this is
 * an unreachable placeholder; the agent CLIs mark the server failed and carry on.
 * Provide the real URL here once the server lands.
 */
export const McpServerUrl = Context.Reference<string>("kkcode/McpServerUrl", {
  defaultValue: () => "http://127.0.0.1:1/mcp",
})
