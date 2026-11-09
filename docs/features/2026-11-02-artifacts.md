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
5. Outside HinaCode, `hinacode-artifacts mcp` gives any MCP harness the same tools, and `hinacode-artifacts serve` previews the store in a browser.

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

`publish` and `remove` hold the same per-artifact filesystem lock across processes. Publication reads the previous manifest under that lock, writes a new version, renames the manifest last, and keeps the current and previous committed versions. An incomplete directory left by a crashed writer cannot replace the previous committed version. The sibling `<id>.lock` directory uses `proper-lockfile`'s heartbeat and stale-lock recovery, so a killed writer does not block future updates permanently.

File reads stay unlocked, so an existing preview remains readable while an update is written. If cleanup removes a file between reading its manifest and opening it, the reader retries only when the manifest has advanced. Paths are relative and normalized, and anything that escapes the version directory is refused. The entry must be one of the files. A version holds at most 16 MB.

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

### Theme

Pages style themselves with the app's theme tokens (`--background`, `--primary`, `--graph-lane-1`, ...), listed in `THEME_TOKENS` in `src/shared/artifactTheme.ts`. The renderer reads their computed values from whatever theme is applied and passes them as `?theme=` on the frame URL. The protocol handler decodes them and inserts a `<style>` on `:root` into every HTML response, so a new theme needs no change here; only exposing a new token does. HinaCode appends the token guide to `publish_artifact`'s description when it registers the tool. The package knows nothing about the theme, so `hinacode-artifacts serve` shows pages unthemed. A theme switch changes the URL, so the page reloads. A frame's own `prefers-color-scheme` follows the OS, not the app, so the guide tells agents not to write one.

### Export

The artifact header has an Export menu with HTML and PDF. `artifacts.export` is a desktop-only rpc: main asks where to save, then loads `hinacode-artifact://<id>/<entry>?theme=...`, so a cloud's artifact exports the same way a local one does. HTML is the entry with the current theme inserted, fetched with `net.fetch`. PDF renders the page in a hidden sandboxed window, waits for fonts and one second for scripts that draw, then calls `printToPDF`. Only the entry is exported; an artifact that links other files exports without them.

### What the frame is doing

A broken page used to sit at "Loading…" with no sign that anything failed, and a new version replaced the old one with no sign it had changed.

- The header shows the version, such as `v3`, so an update is visible.
- Until the frame fires `load`, a thin bar runs along the top of the panel. It fades in after a short delay, so a page that loads at once does not flash it.
- The protocol inserts a small reporter script into every HTML response, next to the theme. Inside a frame it posts `{ type: "hinacode-artifact-problem", message }` to the parent for uncaught errors, unhandled rejections, `console.error` and resources that fail to load. Outside a frame, as in an exported file, it does nothing. The panel accepts a message only from its own frame's window and decodes it with a schema. The page controls the text, so it is shown as plain text and nothing else.
- Problems collect in a strip under the frame, deduplicated and capped at the first 20 messages of 500 characters each, so a page that logs a new error every frame cannot grow the app renderer without limit. "Ask agent to fix" adds the title, id and messages to the thread's draft, so the developer can send it with their own words.

### Artifacts belong to a thread

The list used to hold every artifact from every thread, project and machine, with nothing to say where one came from. A developer looking for "the chart from the migration thread" scanned titles, and an agent after compaction picked an id out of everyone's artifacts.

The manifest now records `threadId`, the thread whose MCP credential published it. The package takes it as a host-supplied `threadId` on `publish`, never from the agent's input, and keeps the creator's on updates, so an artifact stays where it was born. Artifacts from other harnesses have none.

- The panel lists this thread's artifacts first. The rest follow under "Other threads", each row naming its thread, and the row's menu offers "Go to thread".
- `list_artifacts` lists the calling thread's artifacts. `all: true` lists everyone's, with the thread each came from. The stdio server has no thread, so it lists everything as before.

### Check on publish

An agent that publishes a page cannot see it. In the first dogfood run a real turn ended with "I haven't opened it to check how it renders", and a page whose module import failed sat at "Loading…" with nobody told.

So on the desktop, `publish_artifact` renders the new version before it answers. `ArtifactInspector` loads `hinacode-artifact://<id>/<entry>` in a hidden sandboxed window, 400 by 720, the panel's usual width, with the theme the renderer last shared through `artifacts.setTheme`. It attaches DevTools before navigation and keeps `Runtime.exceptionThrown`, `console.error` and `Log.entryAdded` errors, decoded with a schema because the page writes them. After fonts and one second of settling, it measures the page width in an isolated world, names the outermost elements past the edge, and captures the viewport.

The result keeps its first line, so `publishedArtifactId` still reads the id, and adds:

```
Rendered at 400px, the side panel's usual width. Fix these and publish again:
- Console errors:
  - Uncaught ReferenceError: Chart is not defined (index.html:19)
- The page is 663px wide and scrolls sideways in a 400px panel. Past the edge: table.
The screenshot shows the top of the page as the developer first sees it.
```

followed by the screenshot as an MCP image. The PDF export shares the hidden-window code in `artifactPage.ts`. The check gives up after 15 seconds and answers with the plain result, and so does `hinacode serve`, which has no browser: its layer is `ArtifactInspector.unavailable`.

At most two checks render at once, and the rest wait their turn. Each window is a renderer process, and a page that loops keeps a core busy until the timeout, so without the limit six threads publishing together took six cores. A check that waits still gets its full 15 seconds once it starts, so the agent's call can take longer than that when several spinning pages are ahead of it.

### Delete

Right-clicking an artifact in the list offers Delete. `artifacts.delete` routes to the machine that owns the id and removes the artifact's directory. The service pushes `artifact.removed`, and so does its watcher when another harness deletes a directory, so every open list drops it. There is no undo.

The trust boundary is the frame. Artifact HTML is agent output and is treated as hostile: no same origin, no `rpc`, no navigation of the app.

### Publishing a file from disk

An agent that wrote a page to disk used to resend the whole file in the tool call, so the same text was charged twice and landed in the transcript twice. It grew again with every small update.

Each entry of `publish_artifact`'s `files` now takes `sourcePath`, and `publish_document` does too, instead of `content` or `markdown`. Exactly one is allowed. The path must be absolute, because the MCP server's working directory is not the thread's. The MCP server listens on loopback, so it shares a filesystem with the agent.

- The tool layer reads the file, and `store.publish` still takes bytes. So the store has no new input, and the bytes are copied, which means the artifact survives the scratch directory and a later edit needs another publish.
- The schema is flat, with two optional fields and a refinement, rather than a union. Harnesses convert MCP schemas in their own ways, and a flat object does not depend on how each one handles `anyOf`.
- There is no restriction on which path. The agent already runs as this user, and the path is part of the tool call the harness shows and approves.
- A file over the 16 MB cap is refused from its size before it is read.

### Documents

An artifact has a `kind`. Everything above describes a `page`. A `document` is Markdown the developer edits beside the thread. See [document artifacts](2026-11-03-document-artifacts.md).

## Out of scope

- Publishing the package to npm. The bin is TypeScript, which Node refuses to run under `node_modules`, so it needs a build first. Until then the package is private and harnesses run it from the checkout.

- Publishing to a URL, comments and access control. Sharing means connected machines only.
- The phone app. It has no artifact view yet.
- Version history in the UI. The store keeps one previous version for readers in flight, not for browsing.
- Runtime capabilities such as storage shared between viewers.

## Verification

- `packages/artifacts`: real-directory tests for publish, update, path escapes, the size cap and the fetch handler's headers. Independent Node processes exercise concurrent updates, preview reads, publish/delete ordering and recovery after a killed writer leaves an incomplete version.
- `mcp/server.integration.test.ts`: a thread publishes through the built-in MCP server and reads it back.
- The real app with `verify-hinacode`: publish from a scripted turn, open the card, publish again and watch the preview reload. Pair a `hinacode serve` cloud, publish there, and open it from the desktop's Artifacts page.
