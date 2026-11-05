---
name: verify-hinacode
description: Launch, drive and screenshot the hinacode Electron desktop app (Claude Code, Codex and Muse Code threads, worktrees, MCP, settings, ports, automations) in an isolated instance over CDP (headless on Linux, a real window on macOS). Use when you need to prove a hinacode change works in the real app, reproduce a UI bug, or capture before/after screenshots for a PR.
---

# Verify hinacode

hinacode is an Electron 44 app built with electron-vite. The surface a user touches is one window: a sidebar of projects and threads, a chat view per thread with a composer, a thread details side panel, and a settings page. Agents also touch it through the built-in MCP server, and other programs reach it through the automations webhook. This skill starts an isolated instance (on the headless X server on Linux, as a real window on macOS), drives it with `agent-browser` over Chrome DevTools Protocol, and stores evidence in `.context/shots/`.

## What the e2e suite already proves

Run `pnpm test:e2e` first. Playwright drives the built app through the Gherkin scenarios in `e2e/features`, one isolated instance per worker, and covers everything a user can do without an agent turn, a GitHub account or a native dialog: projects and threads (add, errors, collapse, keyboard reorder, rename, archive and unarchive, filters, delete, restart), worktrees (setup script and its variables, setup log, failure, changes and diffs, archive cleanup), ports (listing, scope, the two-click stop), the MCP server contract (tool list, credential checks, `review_changes`, linking and unlinking pull requests, Linear without a key), webhook automations (creation, the one-time secret, unsigned, unknown and disabled deliveries), and settings (language, default model, shortcut recording, conflicts, reset, encrypted secrets). A green run is the proof for those; do not redo them by hand.

This skill is for what a test cannot own: real Claude Code, Codex and Muse Code turns, remote mode against a `hinacode serve` cloud, tools called from inside a turn, GitHub through a real `gh`, deliveries and automations that start threads, native file pickers, and screenshots or videos for a pull request. `features/README.md` lists, per feature, which sub-features are automated and which are left to a verification run.

All helpers live in `scripts/` next to this file. Run from the repo root and set these once per run:

```sh
S=.agents/skills/verify-hinacode/scripts
PORT=9235                                   # CDP port, unique per instance
DATA=/tmp/kk-verify-userdata                # HINACODE_USER_DATA, unique per instance, must start with /tmp/kk-
SHOTS="$(git rev-parse --show-toplevel)/.context/shots"; mkdir -p "$SHOTS"
ab() { agent-browser --session kkv-$PORT-<feature> --cdp $PORT "$@"; }
```

`ab` is a function, not `AB="agent-browser ..."`, because zsh (the macOS default shell) does not word-split `$AB`. It passes `--cdp $PORT` on every command: `agent-browser connect` alone can launch a separate blank browser instead of attaching. `SHOTS` must be absolute: agent-browser resolves a relative screenshot path against its daemon, not your shell, and the file lands in `~/.agent-browser/tmp/`.

## Launch

```sh
$S/launch.sh $PORT $DATA            # pnpm build, then start; add --no-build to reuse out/
```

What it does:

1. Refuses if `$PORT` already answers CDP or `$DATA` belongs to a live instance.
2. On Linux, starts the user-local Xvfb (`~/.local/xvfb/usr/bin/Xvfb :99 -screen 0 1600x1000x24`) if `/tmp/.X11-unix/X99` is missing. Xvfb is shared and is never stopped by cleanup. macOS has no Xvfb: the instance opens a real window on the user's screen.
3. Runs `pnpm build`, then starts Electron with `HINACODE_USER_DATA=$DATA --remote-debugging-port=$PORT out/main/index.js` in a new session (Linux: `DISPLAY=:99 pnpm exec electron --no-sandbox --disable-gpu`; macOS: the Electron binary directly). The session id goes to `$DATA/kk-verify.sid`, the log to `$DATA/electron.log`.
4. Waits until `window.hinacode.rpc("settings.get")` answers, then moves the automations webhook listener to port `40000 + $PORT` (a fresh profile binds 48080, which another instance usually holds).

Ready means it printed `hinacode ready: cdp=... data=... session=... webhook-port=...`. Teardown is [Cleanup](#cleanup). To restart the same profile, for example to prove history restore or resume, run `$S/stop.sh $DATA` and then `$S/launch.sh $PORT $DATA --no-build`.

Isolation: each instance needs its own `HINACODE_USER_DATA` (SQLite, settings, secrets) and its own CDP port. `$DATA` holds `hinacode.sqlite`, `chats/` and `attachments/`; Chromium's profile, with `localStorage`, is `$DATA/chromium`. The MCP server picks a free port by itself. Never drive an instance you did not launch, such as the user's own hinacode or another agent's port 9222 to 9234.

Verification must never access the user's `kkcode Safe Storage` Keychain item. An unpackaged run (`out/main/index.js`) switches itself to Chromium's mock keychain, so no flag is needed. A packaged build does not, so pass `--use-mock-keychain` when you launch one by hand. The mock key is public, so save only dummy secrets in these profiles. Never ask the user to approve a Keychain prompt for verification. Stop the test instance if one appears.

## Doctor

```sh
$S/doctor.sh $PORT $DATA
```

Read-only. Exit 0 means: the recorded session is alive, the CDP port belongs to it, it runs with `HINACODE_USER_DATA=$DATA` (on macOS: it holds `$DATA/hinacode.sqlite` open), the renderer is loaded from this checkout's `out/`, rpc answers, and the webhook listener is ours. Agent CLIs inherit Electron's listening sockets, so doctor treats a port's root holder, the one whose parent does not hold it too, as its owner. It warns when `src/` or `messages/` changed after the last build. Run it first, and again whenever anything looks off. If a line says FAIL, do not drive that instance.

`scripts/proc.sh` is the platform shim the other scripts source. Linux tracks an instance by session id (`setsid`, `pgrep -s`, `ss`, `/proc`). macOS has none of those, so there the instance is its leader's process group plus every descendant, sockets come from `lsof`, and `new_session` is a perl `POSIX::setsid`.

## Drive

Use the same session for every command:

```sh
ab set viewport 1600 1000                                     # redo after every relaunch
ab find role button click --name "Dismiss" --exact            # once per `Update available: <agent>` toast
ab snapshot -i                                                # accessibility tree with @refs
ab find role button click --name "New thread in demo" --exact # role + accessible name
ab find label "Folder or GitHub repository" fill "$DATA/repo"
ab focus 'button[aria-label="Reorder first"]'                 # CSS on aria-label when find has no action for it
ab wait 'h1'                                                  # wait for UI, never a bare sleep after a click
ab screenshot "$SHOTS/<feature>-<step>.png"
```

Without `set viewport` the window is 720 wide: the sidebar auto-hides and home buttons get shortcut suffixes in their names (`Add project Ctrl+Shift+N`), which breaks `--exact`. On macOS shortcut labels read Cmd (`New thread Cmd+N`), and `mod` in a shortcut is Cmd. `Update available: <agent>` toasts arrive seconds after launch, stacked in region `Notifications`, and cover the side panel's top right. Only the front toast's `Dismiss` is clickable, so dismiss them one at a time.

Run `agent-browser skills get electron` once if you have not used agent-browser with Electron before. Always pass `--session`: the default session is shared with other agents.

Handles: prefer accessible names. The English strings are in `messages/en.json` (zh-TW, zh-CN and ja next to it), so a name like `New thread in {project}` is greppable there. Useful ones: `Add project`, `New thread in <project>`, `Actions for <title>`, `Reorder <title>`, combobox `Message` (the composer), group `Workspace` with checkbox `Worktree` and combobox `Branch or pull request`, listboxes `Commands` (`/`), `Mentions` (`@`) and `Pull requests` (`#`), `Allow` / `Allow for session` / `Deny`, tabs `Details` and `Pull requests` in the side panel, link `Settings`.

The composer's picker is one button named `Model: <summary>` (for example `Model: GPT-6.1-Sol, Low, Full access`; the access label appears only for full access). Click it and wait for `ul[aria-label=Model]`. The popover has agent tabs (`Claude Code`, `Codex`, `Muse Code`), one button per model (`find role button click --name "Sonnet 5.5"`, or press `1`-`9`), an `Effort` slider, toggles `Fast` and `Conversation`, and the Access buttons `Supervised` / `Auto` / `Full access` (on Muse Code `Ask me` / `Auto-review` / `Unrestricted`). The slider is an `input[type=range]`: `ab focus 'input[type=range]'` then `ArrowRight`, because `[role=slider]` CSS matches nothing. `Enter` closes the popover. A tab's models load a second after the tab opens on a fresh profile, so wait for its model button. New threads start in `Full access`, which never asks. Picking a model or access on a draft also sets that agent's default for new threads.

The submit button is one button that reads `Send`, `Stop` (running, empty draft) or `Queue` (running, with a draft). It reads `Steer` only while Ctrl (Cmd on macOS) is held, so steer with `ab press Meta+Enter` (`Control+Enter` on Linux) in `Message`, never by clicking `Steer`. There is no status in the thread header; wait for `button[aria-label=Stop]` to appear and disappear.

Settings has a `Back to threads` button. `Escape` also leaves, except while focus is in a text field.

Rules that came out of real runs:

- Pass `--exact` to `find`. A thread's sidebar row is a link with separate buttons `Reorder <title>`, `Snooze <title>`, `Archive <title>` and `Actions for <title>` (delete is `Delete…` in that menu), and names like `Actions for demo` are substrings of others.
- `find` searches the whole page, including what sits behind a dialog: `find label "Name"` in the Add project dialog opened from Settings > Connections fills `#environment-name` behind it. Scope to `[role=dialog]`. Settings repeats names (every agent's combobox is `Default model`, Linear and Slack both have `Save`); use ids such as `#default-model-codex` or `#secret-slack-token`, and scope with CSS when a name could match twice.
- Selects are base-ui popups: click the combobox, `ab wait '[role=option]'`, then `ab find role option click --name "<label>" --exact`. If a popup opens under the header, where a click misses, use the keyboard: `ab focus '<combobox css>'`, `ab press Enter`, `ab press ArrowDown`, `ab press Enter`, then check the combobox text.
- A new thread is its project's draft. `New thread in <project>` opens it under the heading `New thread`, out of the sidebar, and focuses `Message`; clicking it again reopens the same draft; `Ctrl+N` first opens the palette's new-thread list, where you pick the project. The first send lists it in the sidebar as `thread-xxxxx`; read the title with `ab get text h1` then, or rename it from the sidebar menu when a fixed title matters. The first send also renames it (and its worktree branch) in the background, so do not hard-code the placeholder past that point.
- `find` does not wait, and menus, select popups (`[role=option]`), inline inputs and dialogs render a beat after the click. After opening wait for `[role=menu]`, `[role=option]`, `[role=dialog]`, `[role=alertdialog]` or the input; after closing a dialog wait with `ab wait --fn '!document.querySelector("[role=dialog]")'`. A closed select keeps its options in the page, so wait on the combobox's `aria-expanded="false"` instead of on `[role=option]` disappearing. `snapshot` can lag an animation, so trust the wait, not one snapshot.
- base-ui switches, checkboxes and radios keep a hidden 1px `<input>` with the id (`#remote-enabled`); a click on it lands on the header. Click a switch by `find role switch click --name`. Theme radios ignore `find role radio click` (it reports Done and changes nothing); click their text instead: `ab find text "Hina Light" click --exact`.
- `find` supports `click`, `fill`, `check`, `hover`, `text`. For focus or keyboard work use `ab focus '<css>'` and `ab press <Key>`.
- Never run `pnpm build:site-app` or the site dev server at the same time as `pnpm build` in one checkout. Both write `src/renderer/paraglide` with different output structures, and a mixed result renders a blank window with `TypeError: (void 0) is not a function` in the console. Run `pnpm build` again on its own to fix it.
- Global git config may sign commits (a 1Password agent, for example). `seed-repo.sh` turns signing off for its commit; do the same for any commit you make in a scratch repo.
- Routing uses memory history, so there is no URL to open. Navigate by clicking sidebar links. `ab reload` and a relaunch reopen the last route, which `localStorage["hinacode.location"]` holds.

### Seeding and inspecting through rpc

The renderer exposes `window.hinacode.rpc(method, payload)`. The method map with request and response schemas is `src/shared/contract.ts` (`RpcMethods`). `rpc.ts` calls it over CDP and prints the result, or exits 1 with `{"tag","message"}`:

```sh
$S/seed-repo.sh $DATA/repo                          # git repo on main + a gitignored .env
$S/rpc.ts $PORT projects.create "{\"name\":\"demo\",\"rootPath\":\"$DATA/repo\",\"setupScript\":null}"
$S/rpc.ts $PORT threads.create '{"projectId":"<id>"}'    # Claude Code, default model, title thread-xxxxx
$S/rpc.ts $PORT threads.update '{"id":"<id>","title":"t1","model":"claude-sonnet-5-5"}'   # also provider, effort (string or null), fastMode, accessMode
$S/rpc.ts $PORT threads.transcript '{"threadId":"<id>"}'
$S/rpc.ts $PORT mcp.connection '{"threadId":"<id>"}'
```

Use rpc to seed preconditions and to read back side effects. Drive the behavior under test through the UI. Data created by rpc does not show up in an open window until `ab reload`, because the renderer only refreshes its stores for its own calls and push events.

Other helpers:

- `$S/mcp-call.ts '<connection json>' [tool] ['<json args>']` speaks MCP to the built-in server the way an agent does. Without a tool it lists them.
- `$S/webhook.sh <url> <secret> '<json>' [delivery-id]` posts a body signed with `X-HINACODE-Signature: sha256=<hmac>` and prints the response and status.

### Things CDP cannot do

- The native folder and file pickers (`Browse…`, `Attach files`) open GTK dialogs on Xvfb and Cocoa sheets on macOS, which CDP cannot reach. Type the path into `Folder or GitHub repository`. For attachments, paste or drop a `File` through `ab eval`, or stage with `attachments.stage`.
- `Show in folder` and PR links open outside the app. Assert the link `href`, do not click.

### Agents cost money

Every turn calls a real Claude, Codex or Muse Code account. Use `claude-sonnet-5-5` for Claude, the first model in the Codex list, and `Low` effort for Muse Code, whose reminder agents make even a one-word reply cost tens of thousands of tokens. Keep prompts to one short sentence, and stop as soon as the behavior is proven. Prefer features that need no turn (projects, settings, ports, MCP tools via `mcp-call.ts`) when any feature will do.

## Evidence

Evidence goes to `$SHOTS`, which is `.context/shots/` in the repo root (gitignored, never touched by cleanup). Name files `<feature>-<step>.png`, where `<feature>` is the feature file name from `features/`, for example `projects-and-threads-03-thread-created.png`. Text evidence (rpc output, snapshots, curl transcripts) uses the same stem with `.txt`.

Proof standards:

- Exercise the real user path: clicks, typing and keyboard in the window, or the MCP and webhook endpoints that agents and senders use. rpc is for seeding and reading back, not for doing the thing under test.
- Capture the action and the resulting state, not only the final screen: one shot before or during the action, one after.
- Verify side effects next to what is visible: rows via `rpc.ts` (`threads.list`, `threads.transcript`, `pullRequests.list`, `automations.runs`), files and branches with `git -C` and `ls`, listening processes with `ss -ltnp` (Linux) or `lsof -nP -iTCP:<port> -sTCP:LISTEN` (macOS).
- Persistence claims need a second view: `stop.sh` plus `launch.sh --no-build`, then look again.
- No mocks except where a boundary already isolates the outside world, such as a `gh` shim on `PATH` for GitHub.
- Report every sub-feature you skipped and why. Do not count a different entry point as the one you skipped.

## Cleanup

```sh
$S/cleanup.sh $PORT $DATA kkv-$PORT-<feature>
```

It closes the agent-browser session, stops the recorded session (Electron and every agent process it spawned, by session id or, on macOS, process group and descendants, never by name), and deletes `$DATA` with any scratch repo and worktrees inside it. It exits 1 if the CDP port is still in use. Run it after every attempt, failed ones too. Afterwards, `ls "$SHOTS"/<feature>-*` must still list the evidence.

Agent CLIs keep their own transcripts (`~/.claude/projects/`, `~/.codex/sessions/`). Cleanup leaves them alone.

## Helpers

| Script         | Invocation                                             | Purpose                                                                |
| -------------- | ------------------------------------------------------ | ---------------------------------------------------------------------- |
| `launch.sh`    | `$S/launch.sh <port> <data> [--no-build]`              | Build, start an isolated instance, wait for rpc, move the webhook port |
| `doctor.sh`    | `$S/doctor.sh <port> <data>`                           | Read-only health check, exit 1 on any FAIL                             |
| `rpc.ts`       | `$S/rpc.ts <port> <method> ['<json>']`                 | Call `window.hinacode.rpc` over CDP                                    |
| `seed-repo.sh` | `$S/seed-repo.sh <dir>`                                | Throwaway git repo with a gitignored `.env`                            |
| `mcp-call.ts`  | `$S/mcp-call.ts '<connection json>' [tool] ['<json>']` | Act as an agent against the built-in MCP server                        |
| `webhook.sh`   | `$S/webhook.sh <url> <secret> '<json>' [delivery-id]`  | Signed webhook delivery                                                |
| `stop.sh`      | `$S/stop.sh <data>`                                    | Stop the instance and keep its data for a relaunch                     |
| `cleanup.sh`   | `$S/cleanup.sh <port> <data> [ab-session]`             | Stop, close the browser session, delete `<data>`                       |
| `proc.sh`      | `source $S/proc.sh`                                    | Linux and macOS process and socket lookups the scripts share           |

## Feature map

`features/README.md` indexes one file per user-facing feature with its sub-features, entry points, driving recipe and gotchas. Each file names the e2e scenarios that already cover it; a proof covers the remaining entry points the file lists, or reports the ones it skipped.
