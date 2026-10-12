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
- An activity bar on the right switches the thread panel between views, each with its own shortcut: details (workspace, setup log, and TCP ports opened by processes the thread spawned, each with a kill button), a file explorer with git status and a read-only highlighted file viewer, changes with diffs, pull requests, and subagents.
- GitHub through your `gh` login. Each pull request shows its title, draft, open, merged or closed state, CI checks and review decision, refreshed every minute. A worktree branch without a pull request gets a button that pushes it and runs `gh pr create --fill`. Settings > Integrations shows whether `gh` is installed and signed in.
- Automations start a thread from a prompt template with `{{issue.title}}`-style placeholders, optionally in its own worktree. Triggers are a signed webhook and pollers for new GitHub issues, Linear issues and Slack mentions.
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
pnpm test         # node --test for the pure logic (pollers, templates, signatures)
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

## Testing

| Command                 | What runs                                                                                                                                                      |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm test:unit`        | Vitest, in-process: pure helpers, stores, event mapping. Files named `*.test.ts`.                                                                              |
| `pnpm test:integration` | Vitest against real SQLite files, git, child processes and the MCP HTTP server. Files named `*.integration.test.ts`.                                           |
| `pnpm test`             | Both Vitest projects.                                                                                                                                          |
| `pnpm test:e2e`         | Playwright drives the built Electron app through Gherkin scenarios in `e2e/features`. Needs a display: `DISPLAY` or an `Xvfb :99`, or run under `xvfb-run -a`. |

Effect code is tested with `@effect/vitest`: `it.effect` runs under the test clock, `it.live` on the real one, and `layer(...)` shares a built layer across a block. Every e2e worker starts its own kkcode on a throwaway `KKCODE_USER_DATA`, seeds preconditions through `window.kkcode.rpc` or straight into SQLite, and drives the behavior under test through the UI.

Tests never wait on wall-clock timers; oxlint rejects `setTimeout`, `setInterval` and the `timers` modules in test files. Wait on the thing itself instead: a push event, a `PubSub` the service publishes to, a file change, a Playwright locator assertion, or `TestClock.adjust` for code that sleeps. The verification skill in `.agents/skills/verify-kkcode` picks up where e2e stops: real agent turns, GitHub through `gh`, and native dialogs.
