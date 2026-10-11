---
name: verify-kkcode
description: Launch, drive and screenshot the kkcode Electron desktop app (Claude Code and Codex threads, worktrees, MCP, settings, ports, automations) in an isolated headless instance over CDP. Use when you need to prove a kkcode change works in the real app, reproduce a UI bug, or capture before/after screenshots for a PR.
---

# Verify kkcode

kkcode is an Electron 44 app built with electron-vite. The surface a user touches is one window: a sidebar of projects and threads, a chat view per thread with a composer, a thread details side panel, and a settings page. Agents also touch it through the built-in MCP server, and other programs reach it through the automations webhook. This skill starts an isolated instance on the headless X server, drives it with `agent-browser` over Chrome DevTools Protocol, and stores evidence in `.context/shots/`.

All helpers live in `scripts/` next to this file. Run from the repo root and set these once per run:

```sh
S=.cursor/skills/verify-kkcode/scripts
PORT=9235                                   # CDP port, unique per instance
DATA=/tmp/kk-verify-userdata                # KKCODE_USER_DATA, unique per instance, must start with /tmp/kk-
SHOTS="$(git rev-parse --show-toplevel)/.context/shots"; mkdir -p "$SHOTS"
AB="agent-browser --session kkv-$PORT-<feature>"
```

`SHOTS` must be absolute: agent-browser resolves a relative screenshot path against its daemon, not your shell, and the file lands in `~/.agent-browser/tmp/`.

## Launch

```sh
$S/launch.sh $PORT $DATA            # pnpm build, then start; add --no-build to reuse out/
```

What it does:

1. Refuses if `$PORT` already answers CDP or `$DATA` belongs to a live instance.
2. Starts the user-local Xvfb (`~/.local/xvfb/usr/bin/Xvfb :99 -screen 0 1600x1000x24`) if `/tmp/.X11-unix/X99` is missing. Xvfb is shared and is never stopped by cleanup.
3. Runs `pnpm build`, then `KKCODE_USER_DATA=$DATA DISPLAY=:99 pnpm exec electron --no-sandbox --disable-gpu --remote-debugging-port=$PORT out/main/index.js` in a new session. The session id goes to `$DATA/kk-verify.sid`, the log to `$DATA/electron.log`.
4. Waits until `window.kkcode.rpc("settings.get")` answers, then moves the automations webhook listener to port `40000 + $PORT` (a fresh profile binds 48080, which another instance usually holds).

Ready means it printed `kkcode ready: cdp=... data=... session=... webhook-port=...`. Teardown is [Cleanup](#cleanup). To restart the same profile, for example to prove history restore or resume, run `$S/stop.sh $DATA` and then `$S/launch.sh $PORT $DATA --no-build`.

Isolation: each instance needs its own `KKCODE_USER_DATA` (SQLite, settings, secrets) and its own CDP port. The MCP server picks a free port by itself. Never drive an instance you did not launch, such as the user's own kkcode or another agent's port 9222 to 9234.

## Doctor

```sh
$S/doctor.sh $PORT $DATA
```

Read-only. Exit 0 means: the recorded session is alive, the CDP port belongs to it, it runs with `KKCODE_USER_DATA=$DATA`, the renderer is loaded from this checkout's `out/`, rpc answers, and the webhook listener is ours. It warns when `src/` or `messages/` changed after the last build. Run it first, and again whenever anything looks off. If a line says FAIL, do not drive that instance.

## Drive

Attach once, then use the same session for every command:

```sh
$AB connect $PORT
$AB snapshot -i                                                # accessibility tree with @refs
$AB find role button click --name "New thread in demo" --exact # role + accessible name
$AB find label "Root path" fill "$DATA/repo"
$AB focus 'button[aria-label="Reorder first thread"]'          # CSS on aria-label when find has no action for it
$AB wait '[role=dialog]'                                       # wait for UI, never a bare sleep after a click
$AB screenshot "$SHOTS/<feature>-<step>.png"
```

Run `agent-browser skills get electron` once if you have not used agent-browser with Electron before. Always pass `--session`: the default session is shared with other agents.

Handles: prefer accessible names. The English strings are in `messages/en.json` (zh-TW in `messages/zh-TW.json`), so a name like `New thread in {project}` is greppable there. Useful ones: `Add project`, `New thread in <project>`, `Actions for <title>`, `Reorder <title>`, textbox `Message`, buttons `Send` / `Steer` / `Stop`, `Allow` / `Allow for session` / `Deny`, `Show thread details`, `Settings`, `Back to threads`.

Rules that came out of real runs:

- Pass `--exact` to `find`. The open thread's sidebar row is itself a `button` whose name contains `Actions for <title>` and `Reorder <title>`, so a substring match clicks the row instead.
- `find` searches the whole page, including what sits behind a dialog. In a thread view the composer has a `Model` combobox too, so scope dialog controls with CSS: `$AB click '[role=dialog] #thread-model'`.
- Selects are base-ui popups: click the combobox, `$AB wait '[role=option]'`, then `$AB find role option click --name "<label>" --exact`.
- `find` does not wait, and menus, select popups (`[role=option]`), inline inputs and dialogs render a beat after the click. After opening wait for `[role=menu]`, `[role=option]`, `[role=dialog]`, `[role=alertdialog]` or the input; after closing a dialog wait with `$AB wait --fn '!document.querySelector("[role=dialog]")'`. A closed select keeps its options in the page, so wait on the combobox's `aria-expanded="false"` instead of on `[role=option]` disappearing. `snapshot` can lag an animation, so trust the wait, not one snapshot.
- After `stop.sh` and a relaunch the agent-browser session loses its CDP attachment and opens a blank browser. Pass `--cdp $PORT` on every command after a relaunch (or on every command, which is simplest).
- `find` supports `click`, `fill`, `check`, `hover`, `text`. For focus or keyboard work use `$AB focus '<css>'` and `$AB press <Key>`.
- Routing uses memory history, so there is no URL to open. Navigate by clicking sidebar links. `$AB reload` returns to the home route.

### Seeding and inspecting through rpc

The renderer exposes `window.kkcode.rpc(method, payload)`. The method map with request and response schemas is `src/shared/contract.ts` (`RpcMethods`). `rpc.mjs` calls it over CDP and prints the result, or exits 1 with `{"tag","message"}`:

```sh
$S/seed-repo.sh $DATA/repo                          # git repo on main + a gitignored .env
$S/rpc.mjs $PORT projects.create "{\"name\":\"demo\",\"rootPath\":\"$DATA/repo\",\"setupScript\":null}"
$S/rpc.mjs $PORT threads.create '{"projectId":"<id>","title":"t1","provider":"claude","model":"claude-sonnet-5-5"}'
$S/rpc.mjs $PORT threads.transcript '{"threadId":"<id>"}'
$S/rpc.mjs $PORT mcp.connection '{"threadId":"<id>"}'
```

Use rpc to seed preconditions and to read back side effects. Drive the behavior under test through the UI. Data created by rpc does not show up in an open window until `$AB reload`, because the renderer only refreshes its stores for its own calls and push events.

Other helpers:

- `$S/mcp-call.mjs '<connection json>' [tool] ['<json args>']` speaks MCP to the built-in server the way an agent does. Without a tool it lists them.
- `$S/webhook.sh <url> <secret> '<json>' [delivery-id]` posts a body signed with `X-KKCODE-Signature: sha256=<hmac>` and prints the response and status.

### Things CDP cannot do

- The native folder and file pickers (`Browse…`, `Attach files`) open GTK dialogs on Xvfb that CDP cannot reach. Type the path into `Root path`. For attachments, paste or drop a `File` through `$AB eval`, or stage with `attachments.stage`.
- `Show in folder` and PR links open outside the app. Assert the link `href`, do not click.

### Agents cost money

Every turn calls a real Claude or Codex account. Use `claude-sonnet-5-5` for Claude and the first model in the Codex list, keep prompts to one short sentence, and stop as soon as the behavior is proven. Prefer features that need no turn (projects, settings, ports, MCP tools via `mcp-call.mjs`) when any feature will do.

## Evidence

Evidence goes to `$SHOTS`, which is `.context/shots/` in the repo root (gitignored, never touched by cleanup). Name files `<feature>-<step>.png`, where `<feature>` is the feature file name from `features/`, for example `projects-and-threads-03-thread-created.png`. Text evidence (rpc output, snapshots, curl transcripts) uses the same stem with `.txt`.

Proof standards:

- Exercise the real user path: clicks, typing and keyboard in the window, or the MCP and webhook endpoints that agents and senders use. rpc is for seeding and reading back, not for doing the thing under test.
- Capture the action and the resulting state, not only the final screen: one shot before or during the action, one after.
- Verify side effects next to what is visible: rows via `rpc.mjs` (`threads.list`, `threads.transcript`, `pullRequests.list`, `automations.runs`), files and branches with `git -C` and `ls`, processes with `ss -ltnp`.
- Persistence claims need a second view: `stop.sh` plus `launch.sh --no-build`, then look again.
- No mocks except where a boundary already isolates the outside world, such as a `gh` shim on `PATH` for GitHub.
- Report every sub-feature you skipped and why. Do not count a different entry point as the one you skipped.

## Cleanup

```sh
$S/cleanup.sh $PORT $DATA kkv-$PORT-<feature>
```

It closes the agent-browser session, stops the recorded session (Electron and every agent process it spawned, by session id, never by name), and deletes `$DATA` with any scratch repo and worktrees inside it. It exits 1 if the CDP port is still in use. Run it after every attempt, failed ones too. Afterwards, `ls "$SHOTS"/<feature>-*` must still list the evidence.

Agent CLIs keep their own transcripts (`~/.claude/projects/`, `~/.codex/sessions/`). Cleanup leaves them alone.

## Helpers

| Script | Invocation | Purpose |
| --- | --- | --- |
| `launch.sh` | `$S/launch.sh <port> <data> [--no-build]` | Build, start an isolated instance, wait for rpc, move the webhook port |
| `doctor.sh` | `$S/doctor.sh <port> <data>` | Read-only health check, exit 1 on any FAIL |
| `rpc.mjs` | `$S/rpc.mjs <port> <method> ['<json>']` | Call `window.kkcode.rpc` over CDP |
| `seed-repo.sh` | `$S/seed-repo.sh <dir>` | Throwaway git repo with a gitignored `.env` |
| `mcp-call.mjs` | `$S/mcp-call.mjs '<connection json>' [tool] ['<json>']` | Act as an agent against the built-in MCP server |
| `webhook.sh` | `$S/webhook.sh <url> <secret> '<json>' [delivery-id]` | Signed webhook delivery |
| `stop.sh` | `$S/stop.sh <data>` | Stop the instance and keep its data for a relaunch |
| `cleanup.sh` | `$S/cleanup.sh <port> <data> [ab-session]` | Stop, close the browser session, delete `<data>` |

## Feature map

`features/README.md` indexes one file per user-facing feature with its sub-features, entry points, driving recipe and gotchas. A proof covers every entry point the feature file lists, or reports the ones it skipped.
