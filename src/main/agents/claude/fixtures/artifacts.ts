import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { Effect } from "effect"
import {
  type AgentEvent,
  type McpConnection,
  PUBLISH_ARTIFACT_TOOL,
  PUBLISH_DOCUMENT_TOOL,
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

export const publishArtifact = (connection: McpConnection, input: Record<string, unknown>) =>
  Effect.promise(() => callTool(connection, PUBLISH_ARTIFACT_TOOL, input))

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
  const finished = publishArtifact(connection, input).pipe(
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

const DOCUMENT = `> [!NOTE]
> The agent drafts, the developer edits, and the next publish merges both. Ship it behind a flag on Friday.

## Goal

Let the developer edit what the agent writes.

> [!NOTE]
> The document is plain Markdown, so the file still reads well on GitHub and in any editor.

## Steps

- [x] Define the data shape
- [ ] Build the editor
- [ ] Verify in the real app

> [!TIP]
> Press **Ask agent** to hand your edits back without copying text.

> [!IMPORTANT]
> The agent sends the revision it last read.
>
> A stale revision fails, and the response carries the developer's text so the agent can merge it.

> [!WARNING]
> Raw HTML is dropped the first time the developer saves.

> [!CAUTION]
> Deleting a document removes every version.

| Part | Owner |
| --- | --- |
| Store | Agent |
| Editor | Developer |

## Flow

\`\`\`mermaid
graph LR
  Agent --> Store --> Editor
\`\`\`

## Flow

\`\`\`mermaid
flowchart TD
  Agent[Agent publishes] --> Store[(document.md)]
  Store --> Editor[Developer edits]
  Editor -->|Ask agent| Agent
\`\`\`

\`\`\`ts
type ArtifactKind = "page" | "document"
\`\`\`

\`\`\`chart
{
  "type": "bar",
  "title": "Daily sales peaked at ¥63,900 on 10/17",
  "notes": "Total ¥283,675 from 10/15 to 10/19",
  "x": "day",
  "series": [
    { "key": "chat", "label": "Chat" },
    { "key": "drama", "label": "Drama" },
    { "key": "replay", "label": "Replay" }
  ],
  "unit": { "prefix": "¥" },
  "rows": [
    { "day": "10-15", "chat": 25875, "drama": 18700, "replay": 60 },
    { "day": "10-16", "chat": 31900, "drama": 18000, "replay": 0 },
    { "day": "10-17", "chat": 54800, "drama": 9100, "replay": 0 },
    { "day": "10-18", "chat": 52300, "drama": 9200, "replay": 0 },
    { "day": "10-19", "chat": 45700, "drama": 8000, "replay": 40 }
  ]
}
\`\`\`
`

export type MockDocument = {
  readonly id: string
  readonly title: string
  readonly revision: number
  readonly markdown: string
}

const publishedRevision = (output: string) => Number(/revision (\d+) to publish_document/.exec(output)?.[1])

export const documentTurn = (
  callId: string,
  prompt: string,
  connection: McpConnection,
  previous: MockDocument | undefined,
  published: (document: MockDocument) => void,
) => {
  const request = /<request>\n([\s\S]*?)\n<\/request>/.exec(prompt)?.[1] ?? prompt
  const markdown =
    previous === undefined ? `# ${request}\n\n${DOCUMENT}` : `${previous.markdown}\nThe agent added: ${request}\n`
  const input = {
    ...(previous === undefined ? { auto_open: true } : { id: previous.id, revision: previous.revision }),
    title: previous?.title ?? request,
    markdown,
  }
  const started: AgentEvent = {
    type: "tool_call_started",
    callId,
    name: `mcp__hinacode__${PUBLISH_DOCUMENT_TOOL}`,
    input,
  }
  const finished = Effect.promise(() => callTool(connection, PUBLISH_DOCUMENT_TOOL, input)).pipe(
    Effect.map(({ output, isError }): ReadonlyArray<AgentEvent> => {
      const id = publishedArtifactId(output)
      if (id !== null) published({ id, title: input.title, revision: publishedRevision(output), markdown })
      return [
        { type: "tool_call_finished", callId, output, isError },
        { type: "text_delta", text: isError ? "The developer edited the document first." : "Published the document." },
        { type: "turn_completed" },
      ]
    }),
  )
  return { started, finished }
}
