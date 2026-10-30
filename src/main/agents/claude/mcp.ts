// oxlint-disable unicorn/prefer-add-event-listener -- MCP transports take callbacks, not event listeners
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js"
import { isJSONRPCRequest, type JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js"
import type { McpConnection } from "../../../shared/agent.ts"

const relay = async (cli: Transport, http: Transport) => {
  const toCli = (message: JSONRPCMessage) => cli.send(message).catch(() => undefined)
  cli.onmessage = (message) => {
    http.send(message).catch((error: unknown) => {
      if (isJSONRPCRequest(message))
        toCli({ jsonrpc: "2.0", id: message.id, error: { code: -32603, message: String(error) } })
    })
  }
  http.onmessage = toCli
  cli.onclose = () => void http.close()
  await http.start()
  await cli.start()
}

// FIXME: the SDK writes HTTP mcpServers into the CLI's --mcp-config argv, readable by other local users
export const hinacodeMcpServer = (connection: McpConnection): McpSdkServerConfigWithInstance => ({
  type: "sdk",
  name: "hinacode",
  // FIXME: the SDK only calls connect on the instance
  instance: {
    connect: (cli: Transport) =>
      relay(
        cli,
        new StreamableHTTPClientTransport(new URL(connection.url), { requestInit: { headers: connection.headers } }),
      ),
  } as unknown as McpSdkServerConfigWithInstance["instance"],
})
