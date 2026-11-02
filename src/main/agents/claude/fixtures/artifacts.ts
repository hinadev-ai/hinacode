import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { Effect } from "effect"
import {
  type AgentEvent,
  type McpConnection,
  PUBLISH_ARTIFACT_TOOL,
  publishedArtifactId,
} from "../../../../shared/agent.ts"

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`)

const page = (prompt: string, publishedAt: string) => `<!doctype html>
<html>
  <body style="font: 16px/1.5 system-ui, sans-serif; margin: 32px">
    <h1>${escapeHtml(prompt)}</h1>
    <p>Published at ${publishedAt}</p>
    <p id="script">Scripts do not run.</p>
    <script>document.getElementById("script").textContent = "Scripts run in the sandbox."</script>
  </body>
</html>
`

const callTool = async (connection: McpConnection, name: string, args: Record<string, unknown>) => {
  const client = new Client({ name: "hinacode-mock", version: "0" })
  await client.connect(
    new StreamableHTTPClientTransport(new URL(connection.url), { requestInit: { headers: connection.headers } }),
  )
  try {
    const result = await client.callTool({ name, arguments: args })
    const content = result.content as ReadonlyArray<{ readonly text?: string }>
    return { output: content.map((part) => part.text ?? "").join(""), isError: result.isError === true }
  } finally {
    await client.close()
  }
}

export const artifactTurn = (
  callId: string,
  prompt: string,
  connection: McpConnection,
  previousId: string | undefined,
  published: (id: string) => void,
) => {
  const input = {
    ...(previousId !== undefined && { id: previousId }),
    title: prompt,
    files: [{ path: "index.html", content: page(prompt, new Date().toISOString()) }],
  }
  const started: AgentEvent = {
    type: "tool_call_started",
    callId,
    name: `mcp__hinacode__${PUBLISH_ARTIFACT_TOOL}`,
    input,
  }
  const finished = Effect.promise(() => callTool(connection, PUBLISH_ARTIFACT_TOOL, input)).pipe(
    Effect.map(({ output, isError }): ReadonlyArray<AgentEvent> => {
      const id = publishedArtifactId(output)
      if (id !== null) published(id)
      return [
        { type: "tool_call_finished", callId, output, isError },
        { type: "text_delta", text: isError ? "Publishing failed." : "Published the artifact." },
        { type: "turn_completed" },
      ]
    }),
  )
  return { started, finished }
}
