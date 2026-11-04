# @hinacode/artifacts

Local artifacts for coding agents. An agent publishes an HTML page, or a few files, through MCP, and you open it in a browser or in HinaCode. Every page renders in a sandboxed frame: scripts run, but the page never shares an origin with its host.

An agent can also publish a Markdown document, which HinaCode opens in an editor so the developer can change it. A document is an artifact with `kind: "document"` and one file, `document.md`.

Artifacts live in `$HINACODE_ARTIFACTS`, or `~/.hinacode/artifacts`, which is also where the HinaCode desktop app looks.

## Add the MCP server

The package is not on npm yet, because Node does not strip types under `node_modules`. Until it ships a build, point the harness at the checkout.

Claude Code:

```sh
claude mcp add artifacts -- node /path/to/hinacode/packages/artifacts/src/cli.ts mcp
```

Codex, in `~/.codex/config.toml`:

```toml
[mcp_servers.artifacts]
command = "node"
args = ["/path/to/hinacode/packages/artifacts/src/cli.ts", "mcp"]
```

The server has five tools: `publish_artifact`, `publish_document`, `document_chart_guide`, `list_artifacts` and `read_artifact`. Publishing again with the same id updates the artifact in place. Both publish tools take the absolute `sourcePath` of a file on the server's machine in place of its content, so an agent that already wrote the file does not send it again. The file is copied when it publishes. `publish_document` also takes the revision the agent last saw, and refuses the update with the current text when someone else saved since. An update without `title` keeps the current one, which the developer may have changed with `store.rename`; renaming does not count as a revision.

A document can hold bar and line charts as a fenced code block whose language is `chart` and whose body is JSON. The syntax lives in `CHART_GUIDE`, which `document_chart_guide` returns, so an agent reads it only when it is about to draw a chart.

Processes sharing a store serialize updates and deletion per artifact. Readers can keep loading the current version during publication. The store retains the previous committed version and recovers stale locks left by a crashed process.

## Preview

```sh
node packages/artifacts/src/cli.ts serve --port 4100
```

Open `http://127.0.0.1:4100` for the list. An open artifact reloads when the agent publishes a new version. The server listens on loopback only.

## Use it from code

```ts
import { handleArtifactRequest, openArtifactStore, registerArtifactTools } from "@hinacode/artifacts"

const store = openArtifactStore("/path/to/artifacts")
registerArtifactTools(mcpServer, store)
const response = await handleArtifactRequest(store, new Request("http://localhost/<id>/"))
```
