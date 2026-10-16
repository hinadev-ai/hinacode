# hinacode foundation

Status: Shipped
Date: 2026-10-11

## Problem

A developer running Claude Code and Codex at the same time ends up with a pile of terminals. Each one has its own checkout, its own approvals, and its own idea of which PR it opened. Nothing shows which agent needs attention, which port it left open, or whether its branch merged. Existing harnesses solve part of this, but as a server plus a web client, and they don't cover worktree cleanup, review tools or issue triggers the way we want.

hinacode is a local desktop app that puts both agents into one sidebar. Each thread can have its own worktree, and the app cleans up after the work is merged. Remote machines are out of scope.

## User flow

1. **Add a project.** Pick a folder and optionally write a setup script (for example `cp "$HINACODE_ROOT_PATH/.env" .`). Importing trusts the project, so its `.claude` settings and `CLAUDE.md` load as they do in the CLI.
2. **Start a thread** (`mod+n`). Choose Claude or Codex and a model from the agent's live list, and choose whether to branch into a new worktree. The setup log streams in the side panel.
3. **Chat.**
   - Attach images or files by button, paste or drop.
   - Approve commands, edits and MCP calls inline: allow once, allow for session (scoped to exactly what the card shows), or deny.
   - Send again while a turn runs to steer it.
4. **Watch the side panel.** It shows the workspace path, changed files with diffs, linked PRs with merge state, and ports the thread's processes opened, each with a kill button.
5. **Ship.** The agent calls `review_changes`, opens a PR, and calls `link_pull_request`. The PR appears on the thread.
6. **Archive.** Archiving moves the thread to the sidebar's Archived tab. With worktree removal on in settings, it also removes the worktree and deletes the branch if it's merged into its base.
7. **Automate.** An automation turns a signed webhook, a new GitHub issue, a new Linear issue or a Slack mention into a new thread. The prompt comes from a template such as `{{issue.title}}`, and the thread can get its own worktree.

## Design

The system map is in [`../arch.md`](../arch.md), and decisions that are costly to reverse are in [`../adr/`](../adr/). In short:

- **One process does the work.** The Electron main process runs one Effect runtime with every service, both agent adapters, the MCP server and the automation servers ([ADR 0001](../adr/0001-single-process-electron.md), [0002](../adr/0002-effect-in-main.md)). The renderer is a view over a schema-typed `rpc` channel plus an `event` push channel ([0004](../adr/0004-typed-rpc-and-push-channels.md)).
- **SQLite** through built-in `node:sqlite`, with no ORM and no native rebuild ([0003](../adr/0003-node-sqlite-no-orm.md)).
- **Agents behind one interface.** Claude runs through one long-lived Agent SDK `query()` per thread. Codex runs through one shared `codex app-server` over stdio. Both emit the same `AgentEvent` union, which one pure `foldEvent` turns into messages. Nothing is event-sourced ([0005](../adr/0005-agent-event-stream-not-event-sourcing.md)).
- **Steering** is native in both agents: Claude gets a `priority: "now"` message, Codex gets `turn/steer`. The assistant message splits at the steer point, so the transcript reads in the order things happened.
- **Worktrees** live in `<parent>/.hinacode-worktrees/<project>/` with an id suffix. A branch has one live worktree, and removal is refused while it's in use ([0006](../adr/0006-worktree-ownership.md)).
- **Built-in MCP server** on loopback, authenticated per thread ([0007](../adr/0007-per-thread-mcp-credentials.md)).
- **Trust.** Importing a project trusts it, and there is no trust setting ([0008](../adr/0008-import-trusts-the-project.md)). Session approvals cover only what the card showed ([0009](../adr/0009-scoped-session-approvals.md)).
- **Attachments** are copied to `<userData>/attachments/<thread>/`.
  - Images go to the model: base64 for Claude (5 MB cap) and `localImage` for Codex.
  - Other files are passed by absolute path, and the agent reads them with its own tools.
  - Thumbnails are served by `hinacode-attachment://`, which refuses paths outside that directory.
- **Ports** come from `/proc/net/tcp{,6}` on Linux and from `lsof` plus `ps` on macOS. Other platforms list none. A port belongs to a thread when its process runs in the thread's workspace or descends from the thread's agent. Kill sends SIGTERM, then SIGKILL after 3 s, and only to processes that own a listening socket.
- **Automations.**
  - The webhook server listens on 127.0.0.1:48080 by default, separate from the MCP server. It accepts an HMAC in `x-hinacode-signature` or GitHub's `x-hub-signature-256`.
  - Pollers run every 60 s from a cursor established when an enabled automation is saved, or when a disabled automation is first enabled. The first poll fetches new events. Re-enabling keeps the saved cursor.
  - Runs are deduplicated by event key.
  - Saving a Linear API key enables agent tools. Starting threads automatically requires an enabled Linear issue automation under Settings > Automations.
- **UI.**
  - Stack: shadcn on Base UI, Remix icons, `@legendapp/list` for the transcript, `@pierre/diffs`, dnd-kit for the sidebar, TanStack Router (memory history), zustand stores fed by pushes.
  - Copy: every string is a typed Paraglide message in English and 繁體中文.
  - Shortcuts: rebindable, with only overrides stored and conflicts flagged.
- **Verification** uses the `verify-hinacode` skill: isolated instances under Xvfb, driven over CDP, with a recipe per feature.

## Out of scope

- **Remote machines.** hinacode drives agents on the machine it runs on.
- **A separate server process.** A server plus WebSocket split solves remote access, which we don't need.
- **An integrated terminal** (xterm plus node-pty). We researched it and didn't build it. Agents run commands; the ports panel covers the "what is still running" question.
- **Editing, branching or regenerating earlier messages.** The agent sessions own their history, so the UI can't rewrite it ([0011](../adr/0011-no-assistant-ui.md)).

## Known gaps

- **Theme:** light mode and system appearance (#4). The app is dark-only today.
- **Layout:** the composer is unusable at the minimum window size (#2).
- **Performance:**
  - Streamed Markdown is re-parsed on every delta (#12).
  - `threads.create` waits for the setup script to finish (#33).
  - Transcripts load whole, so a 1000-turn thread holds tens of MB. Paging through LegendList is the structural fix.
- **Worktrees:** there is no "retry setup" for a worktree whose setup a quit interrupted.
- **Steering and stop:**
  - Steering Claude doesn't interrupt a running Bash tool.
  - Stop pressed within a tick of Send does nothing.
- **Linear:** verified with KAL-32 through the real API in an isolated app profile, including a Codex reply. Cursor lifecycle coverage uses a scripted external Linear transport with real SQLite, automation, thread, and runner services.
- **Untested:** Slack pollers have only been tested against fakes.

## Verification

Each feature has a recipe in `.agents/skills/verify-hinacode/features/`. Pure logic (folding, pollers, templates, signatures, parsers) has unit tests. Worktrees, the MCP server, ports and the Codex adapter run against real git repos, real SQLite, real HTTP and a fake app-server.
