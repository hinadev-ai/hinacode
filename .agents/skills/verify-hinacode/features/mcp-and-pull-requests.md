# MCP tools and pull request links

hinacode runs one MCP server on 127.0.0.1 and hands each agent run a bearer credential bound to its thread; the credential alone decides which thread a call acts as. Agents use it to review their changes (`review_changes`), register and watch the pull requests they open (`link_pull_request`, `list_thread_pull_requests`, `unlink_pull_request`, `watch_pull_request`, `unwatch_pull_request`), work with Linear (`linear_get_issue`, `linear_search_issues`, `linear_create_comment`, `linear_update_issue_state`), ask the user for a secret through a card in the thread (`request_secret`), start sibling threads (`create_thread`), run another agent (`run_agent`, `wait_agent`), list the user's machines (`list_machines`), check on, steer or stop the threads of their project (`list_threads`, `search_threads`, `read_thread`, `send_to_thread`, `stop_thread`), read their terminals (`list_terminals`, `read_terminal`), and publish artifacts (`publish_artifact` and the other artifact tools). `vm_*` appear when Tiny VM is on and `device_*` when Experimental > Devices is on. `src/main/mcp/tools/index.ts` registers the full list. Linked pull requests appear in the side panel's `Source control` tab with their status from `gh` or `glab`, where the user can open, watch, merge, close, comment on or unlink them, and open the changes in a separate review window. The desktop has no button to create a pull request; agents open them, and `pullRequests.create` remains as rpc for the phone app.

## Automated coverage

`e2e/features/mcp.feature` talks to the server with the real MCP SDK as the thread's agent: a list of tool names that must be present (not an exact list), including `request_secret`, `create_thread` and the thread controls, a wrong credential getting 401, `review_changes` reporting a diff, `link_pull_request` showing up in the panel live and `Unlink` emptying it, a non-PR URL being refused, the Linear tools explaining the missing key, and `request_secret` refusing a call outside a running turn. `src/main/mcp/server.integration.test.ts` covers the credential rules, the secret/create-thread lifecycles and the thread controls with stub providers.

## Sub-features

- `tools-list`, `auth`, `review-changes`, `link-pr`, `panel-links`, `unlink`, `linear` (e2e).
- `link-pr-in-turn` an agent calls `link_pull_request` during a real turn and the panel updates live.
- `watch` `watch_pull_request` links the PR if needed and wakes the thread with a message when its checks, review, conflicts or state change; `unwatch_pull_request` stops that and keeps the link. `mcp-call.ts` drives both without a turn.
- `watch-ui` the PR detail's `Watch for changes` / `Watching` button, and the sidebar row's eye badge under the thread.
- `pr-status` the panel shows one PR in detail as an `article` named after its title: `#<n>`, `base ← head`, state (`Merged`, …), author, `+/-`, tabs `Info` / `Changes` (and `Guide` when Settings > Providers `Pull request guide` is on), checks, description and comments. `Linked PRs <n>` in the header opens the list of every linked PR. Status comes from `gh api graphql` (including `mergeable`).
- `review-window` `Changes` > `Open changes in a new window` opens a second window with `Unified` / `Split`, `Filter files`, `Viewed` checkboxes and gutter comments.
- `pr-create` `pullRequests.create` pushes the branch and runs `gh pr create --head <branch> --base <baseRef> --fill`. Desktop UI: none.
- `gh-auth` Settings > Integrations > GitHub reads the signed-in, not-installed or not-signed-in state; the panel shows one hint instead of per-row errors when signed out.

- `request-secret` (service integration; real-turn UI recipe below) during a turn, `request_secret` shows a `<provider> asks for a secret` card with the description, the name and a masked input; Save writes the value to `secrets/<name>` in the thread's scratch directory (mode 600) and the tool returns that path, never the value; Decline returns an error result; the card goes away either way. Outside a turn the tool fails with `No turn is running`.
- `create-thread` (service integration; real-turn UI recipe below) `create_thread` adds a thread to the caller's project; it shows in the sidebar without a reload, runs its prompt as the first turn, and `threads.list` shows `createdBy` as `thread:<caller>`.
- `thread-controls` (service integration) `list_threads` lists the non-archived threads of the caller's project, including those of the same GitHub repository on the user's other machines, and marks the caller; `read_thread` shows a thread's status, pending approvals or questions, and latest messages; `send_to_thread` starts a turn on an idle thread and steers a running one; `stop_thread` interrupts it. Threads of another project are refused, and send/stop refuse the caller itself.

## How to get to it (user POV)

- Users do not call the tools; they ask an agent to, for example `Open a PR and link it`, and see the result in the side panel's `Source control` tab (`Mod+Shift+M`), the sidebar row (`#<n>` under the title) and the overview card's `Pull request actions` menu.

## Driving it with agent-browser and mcp-call.ts

Preconditions:

- Instance launched, doctor passes, project `demo` on `$DATA/repo`, a Claude thread `mcp check` (`Sonnet 5.5`) open with the panel visible. `gh` signed in for the status steps.
- `ab() { agent-browser --session kkv-$PORT-mcp-and-pull-requests --cdp $PORT "$@"; }`.
- `CONN=$($S/rpc.ts $PORT mcp.connection "{\"threadId\":\"$TID\"}")`.

- **Tool list (no turn).** `$S/mcp-call.ts "$CONN" > "$SHOTS/mcp-and-pull-requests-00-tools.txt"` lists the tools.
- **Watch (no turn).** `$S/mcp-call.ts "$CONN" watch_pull_request '{"url":"https://github.com/hinadev-ai/hinacode/pull/491","events":["commented"]}'` answers `Watching … for commented`, and `list_thread_pull_requests` says `(watching for commented; 0 wakes)`. The sidebar row gains `#491` with an eye. `ab find role tab click --name "Pull requests" --exact`, `ab wait 'article[aria-label]' --timeout 20000`: the detail shows the PR's title, `Merged`, checks and comments. Screenshot `mcp-and-pull-requests-01-watching.png`. `unwatch_pull_request` answers `Stopped watching …` and the link stays.
- **Link from an agent turn.** Send `Call the hinacode link_pull_request tool with url https://github.com/hinadev-ai/hinacode/pull/1, nothing else.` If a `Claude Code needs your approval` card names `mcp__hinacode__link_pull_request`, click `Allow` (`--exact`). The tool row turns `Done` and, without a reload, the `Pull requests` tab shows it: the detail `article` with `#1` when `gh` is signed in, or the fallback row `hinadev-ai/hinacode#1` with `Unlink hinadev-ai/hinacode#1` when it is not. Screenshot `mcp-and-pull-requests-02-linked-in-turn.png`.
- **Status.** Link at least two real pull requests such as `https://github.com/hinadev-ai/hinacode/pull/32` (read-only), open `Linked PRs`, and compare `$S/rpc.ts $PORT github.pullRequest '{"url":"..."}'` with `gh pr view <n> -R hinadev-ai/hinacode --json title,state,isDraft,reviewDecision,statusCheckRollup,author,headRefName,baseRefName,additions,deletions`. Screenshot `mcp-and-pull-requests-02-status.png`.
- **Create without touching GitHub.** Give the seeded repo a bare `origin`, and launch with a `gh` shim first on `PATH` that logs `pr create` and prints a PR URL, answers `pr view <branch>` with `no pull requests found for branch` until then, and passes everything else to the real `gh`. Commit in the worktree, run `$S/rpc.ts $PORT pullRequests.create '{"threadId":"<id>"}'`, and check the log for `pr create --head <branch> --base main --fill` run in the worktree. The new link appears through the push. This is the phone app's path; say so.
- **gh missing or signed out.** Launch with every `PATH` entry holding a `gh` removed, or with `GH_CONFIG_DIR` pointing at an empty directory and `GH_TOKEN`/`GITHUB_TOKEN` unset. `$S/rpc.ts $PORT github.auth` prints `missing` or `signedOut`, Settings > Integrations shows the matching sentence, and the panel shows the single hint. Screenshot `mcp-and-pull-requests-03-gh-signed-out.png`.

- **Request a secret in a turn.** Read `TID` from `$S/rpc.ts $PORT threads.list` first. Send `Call the hinacode request_secret tool with name DEMO_TOKEN and description "Demo API token for verification", then run wc -c on the file it returns. Nothing else.` Allow the tool if asked. A `Claude Code asks for a secret` card appears with `Stored as DEMO_TOKEN` and a `Secret value` password field. Screenshot `mcp-and-pull-requests-05-secret-card.png`. `ab find label "Secret value" fill "verify-value"`, then `ab find role button click --name "Save" --exact`. The card disappears, the tool row turns `Done` with a path ending in `secrets/DEMO_TOKEN`, and the agent's `wc -c` prints `12`. `stat -c %a` (Linux) or `stat -f %Lp` (macOS) on that path prints `600`; `$S/rpc.ts $PORT threads.transcript "{\"threadId\":\"$TID\"}"` must not contain `verify-value`. Screenshot `-06-secret-stored.png`.
- **Create a thread.** Send `Call the hinacode create_thread tool with title "Child thread" and prompt "Reply with the single word pong.", then report the id. Nothing else.` The sidebar gains `Child thread` under `demo` while the first thread is still running. Screenshot `mcp-and-pull-requests-07-child-thread.png`. `$S/rpc.ts $PORT threads.list` shows it with `createdBy` `thread:<TID>`.

## Gotchas

- The credential is per thread and changes on every launch. Re-read `mcp.connection` after `launch.sh`.
- Codex gates every hinacode tool call behind an approval card (MCP elicitation). See `chat-codex.md`.
- Never call `pullRequests.create` against a real GitHub remote while verifying; it opens a real pull request.
- The empty panel still reads `None linked yet. Create one from this branch, …` although the desktop has no create button. That is stale product copy, not a missing button.
- `request_secret` waits for the user; Codex allows 3600 seconds for every hinacode tool call (`tool_timeout_sec`).
- Real Linear calls hit the user's workspace. Only run the Linear tools with a key the user gave you for testing.
