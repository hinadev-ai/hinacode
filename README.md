<img src="assets/icon.svg" width="64" height="64" alt="">

# kkcode

A local desktop app for running Claude Code and Codex against your repositories. One sidebar of threads grouped by project, each thread optionally in its own git worktree, both agents streaming into the same chat.

## Features

- Claude Code through the Agent SDK and Codex through the app-server protocol, selectable per thread, with the model picked from each agent's live list.
- Threads grouped by project in the left sidebar. Drag to reorder, rename inline, settle or delete from the row menu.
- Git worktree per thread. A project-level setup script runs in the new worktree with `$KKCODE_ROOT_PATH`, `$KKCODE_WORKTREE_PATH` and `$KKCODE_BRANCH` set, so copying a `.env` is one line. Settling a thread removes the worktree and deletes the branch when it is merged.
- CLAUDE.md, AGENTS.md and skills load from the project and your home directory, as they do in the CLIs.
- Approvals for commands, edits and MCP tool calls appear inline. Steer a running turn by sending another message.
- Images and files attach by button, paste or drop. Images go to the model, other files are passed by absolute path.
- Built-in MCP server exposed to both agents: `review_changes`, `link_pull_request`, `list_thread_pull_requests`, `unlink_pull_request`, and Linear issue tools backed by an API key stored with Electron's safeStorage.
- Thread panel shows the workspace, setup log, changes with diffs, pull request links with merge state, and TCP ports opened by processes the thread spawned, each with a kill button.
- English and 繁體中文, switchable in settings.
- Rebindable keyboard shortcuts with chord recording and conflict detection.
- SQLite persistence through Node's built-in `node:sqlite`, so there is nothing native to rebuild.

## Development

Requires Node 24 or later, pnpm, and the `claude` and `codex` CLIs on your PATH and logged in.

```sh
pnpm install
pnpm dev
```

```sh
pnpm build        # bundles main, preload and renderer into out/
pnpm typecheck
pnpm lint
pnpm format
```

Run a built app with its own data directory, for example to keep a test profile apart from your real one:

```sh
KKCODE_USER_DATA=/tmp/kkcode-test pnpm exec electron out/main/index.js
```

Headless verification on a machine without a display uses Xvfb and Chrome DevTools:

```sh
Xvfb :99 -screen 0 1600x1000x24 &
DISPLAY=:99 pnpm exec electron --no-sandbox --disable-gpu --remote-debugging-port=9222 out/main/index.js
```

## Layout

```
src/main      Electron main process. One Effect runtime, services under services/, agents under agents/,
              the MCP server under mcp/, SQLite client and migrations under db/.
src/preload   contextBridge exposing window.kkcode (rpc, onEvent, pathForFile).
src/renderer  React 19 + TanStack Router. components/, routes/, stores/ (zustand), keybindings/, paraglide/ (generated).
src/shared    Effect Schema contracts shared by all three: domain types, the rpc method map, agent events.
messages/     Paraglide catalogs, en.json and zh-TW.json. Every UI string lives here.
```

Renderer and main talk over a single `rpc` IPC channel. Each method in `src/shared/contract.ts` has a request and response schema that both sides decode. Main pushes live updates on the `event` channel.

Adding an agent backend means one implementation of `AgentProvider` in `src/main/agents/` and one line in the runner's provider registry.
