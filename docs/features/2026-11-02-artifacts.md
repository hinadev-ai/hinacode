# Artifacts

Status: Building
Date: 2026-11-02

## Problem

Agents often finish with something to look at: a report, a chart, a prototype, a diagram. Today they write an HTML file into the worktree and the developer has to find it, open it, and keep it out of the commit. Claude's artifacts solve this for one harness and one hosted service. Codex, Muse Code and a plain Claude Code CLI session have nothing, and an artifact made on a cloud machine cannot be seen from the desktop at all.

## User flow

1. An agent in any thread calls `publish_artifact` with a title and its files. The tool answers with the artifact id.
2. The tool call in the transcript shows a card with the title. Clicking it opens the Artifacts side panel on that artifact, rendered in a sandboxed frame.
3. The agent calls `publish_artifact` again with the same id. The open preview reloads to the new version.
4. The Artifacts side panel lists every artifact on every connected machine, newest first, with the machine it lives on. An artifact on a cloud opens on the desktop the same way a local one does.
5. Outside HinaCode, `npx @hinacode/artifacts mcp` gives any MCP harness the same tools, and `npx @hinacode/artifacts serve` previews the store in a browser.

## Design

### The package

`packages/artifacts` (`@hinacode/artifacts`) is plain TypeScript with no Effect and no Electron, so any harness can use it. It owns the format, the store, the MCP tool definitions and an HTTP handler. HinaCode is one consumer.

On disk, one directory per artifact:

```
<root>/<id>/artifact.json    the manifest, written last by rename
<root>/<id>/<version>/...    the files of that version
```

```ts
type ArtifactFile = { path: string; type: string; size: number }
type Artifact = {
  id: string
  title: string
  entry: string
  version: number
  files: ArtifactFile[]
  createdAt: string
  updatedAt: string
}
```

`publish` writes the next version directory, renames the manifest over the old one, then deletes versions older than the previous one. A reader that picked up the old manifest still finds its files. Paths are relative and normalized, and anything that escapes the version directory is refused. The entry must be one of the files. A version holds at most 16 MB.

The package exports:

- `openArtifactStore(root)` with `publish`, `get`, `list` and `file`.
- `artifactTools`, the three MCP tools as zod schemas plus handlers: `publish_artifact`, `list_artifacts` and `read_artifact`. One definition feeds both the stdio server and HinaCode's MCP server.
- `handleArtifactRequest(store, request)`, a fetch handler for `/<id>/<path>` that answers with `Content-Security-Policy: sandbox allow-scripts`, so a page can run scripts but never shares an origin with its host.
- A bin, `hinacode-artifacts`, with `mcp` (stdio MCP server) and `serve` (loopback HTTP preview with a list page).

The store root is `$HINACODE_ARTIFACTS` or `~/.hinacode/artifacts`, which is the packaged desktop's store, so artifacts from a CLI session on the same machine show up in HinaCode.

### In HinaCode

- `services/Artifacts.ts` opens the store at `<dataDir>/artifacts` and watches it. A changed manifest pushes `artifact.updated`, whether HinaCode's MCP server or another harness wrote it.
- The built-in MCP server registers `artifactTools` through an adapter in `mcp/tools/artifacts.ts`.
- rpc `artifacts.list` routes to `all`, so the desktop gathers every cloud's artifacts. `artifacts.file` routes by a new `artifact` owner entity and returns a data URL, like `fs.preview`.
- The `hinacode-artifact://<id>/<path>` protocol serves a file from the local store, or forwards `artifacts.file` to the cloud that owns the id. Every response carries the sandbox CSP.
- The renderer adds an `artifacts` side panel view: the gathered list, and the selected artifact in an `<iframe sandbox="allow-scripts">` keyed by version. The `publish_artifact` tool call renders as a card that opens that view on its artifact.

The trust boundary is the frame. Artifact HTML is agent output and is treated as hostile: no same origin, no `rpc`, no navigation of the app.

## Out of scope

- Publishing to a URL, comments and access control. Sharing means connected machines only.
- The phone app. It has no artifact view yet.
- Version history in the UI. The store keeps one previous version for readers in flight, not for browsing.
- Runtime capabilities such as storage shared between viewers.

## Verification

- `packages/artifacts`: unit tests over a temp directory for publish, update, path escapes, the size cap and the fetch handler's headers.
- `mcp/server.integration.test.ts`: a thread publishes through the built-in MCP server and reads it back.
- The real app with `verify-hinacode`: publish from a scripted turn, open the card, publish again and watch the preview reload. Pair a `hinacode serve` cloud, publish there, and open it from the desktop's Artifacts page.
