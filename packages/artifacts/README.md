# @hinacode/artifacts

Local artifacts for coding agents. An agent publishes an HTML page, or a few files, through MCP, and you open it in a browser or in HinaCode. Every page renders in a sandboxed frame: scripts run, but the page never shares an origin with its host.

Artifacts live in `$HINACODE_ARTIFACTS`, or `~/.hinacode/artifacts`, which is also where the HinaCode desktop app looks.

## Add the MCP server

Claude Code:

```sh
claude mcp add artifacts -- npx -y @hinacode/artifacts mcp
```

Codex, in `~/.codex/config.toml`:

```toml
[mcp_servers.artifacts]
command = "npx"
args = ["-y", "@hinacode/artifacts", "mcp"]
```

The server has three tools: `publish_artifact`, `list_artifacts` and `read_artifact`. Publishing again with the same id updates the artifact in place.

## Preview

```sh
npx @hinacode/artifacts serve --port 4100
```

Open `http://127.0.0.1:4100` for the list. An open artifact reloads when the agent publishes a new version. The server listens on loopback only.

## Use it from code

```ts
import { handleArtifactRequest, openArtifactStore, registerArtifactTools } from "@hinacode/artifacts"

const store = openArtifactStore("/path/to/artifacts")
registerArtifactTools(mcpServer, store)
const response = await handleArtifactRequest(store, new Request("http://localhost/<id>/"))
```
