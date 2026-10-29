import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"

export interface McpConnection {
  readonly url: string
  readonly headers: { readonly authorization: string }
}

const asAgent = async <T>(connection: McpConnection, run: (client: Client) => Promise<T>) => {
  const client = new Client({ name: "hinacode-e2e", version: "0" })
  await client.connect(
    new StreamableHTTPClientTransport(new URL(connection.url), { requestInit: { headers: connection.headers } }),
  )
  try {
    return await run(client)
  } finally {
    await client.close()
  }
}

export const listTools = (connection: McpConnection) =>
  asAgent(connection, async (client) => (await client.listTools()).tools.map((tool) => tool.name))

export const callTool = (connection: McpConnection, name: string, args: Record<string, unknown> = {}) =>
  asAgent(connection, async (client) => {
    const result = await client.callTool({ name, arguments: args })
    const content = result.content as ReadonlyArray<{ type: string; text?: string }>
    return { isError: result.isError === true, text: content.map((part) => part.text ?? "").join("\n") }
  })

export const postAs = async (connection: McpConnection, authorization: string) => {
  const response = await fetch(connection.url, {
    method: "POST",
    headers: { authorization, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  })
  return response.status
}
