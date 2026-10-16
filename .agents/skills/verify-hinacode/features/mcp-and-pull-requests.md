# MCP tools and pull request links

hinacode runs one MCP server on 127.0.0.1 and hands each agent run a bearer credential bound to its thread; the credential alone decides which thread a call acts as. Agents use it to review their changes (`review_changes`), register the pull requests they open (`link_pull_request`, `list_thread_pull_requests`, `unlink_pull_request`), work with Linear (`linear_get_issue`, `linear_search_issues`, `linear_create_comment`, `linear_update_issue_state`), ask the user for a secret through a card in the thread (`request_secret`), start sibling threads (`create_thread`), and check on, steer or stop the threads of their project (`list_threads`, `read_thread`, `send_to_thread`, `stop_thread`). Linked pull requests appear in the thread's side panel with their status from `gh`, where the user can open or unlink them, and a worktree branch without a pull request offers `Create pull request`.

## Automated coverage

`e2e/features/mcp.feature` talks to the server with the real MCP SDK as the thread's agent: the fourteen-tool list including `request_secret`, `create_thread` and the thread controls, a wrong credential getting 401, `review_changes` reporting a diff, `link_pull_request` showing up in the panel live and `Unlink` emptying it, a non-PR URL being refused, the Linear tools explaining the missing key, and `request_secret` refusing a call outside a running turn. `src/main/mcp/server.integration.test.ts` covers the credential rules, the secret/create-thread lifecycles and the thread controls with stub providers.

## Sub-features

- `tools-list`, `auth`, `review-changes`, `link-pr`, `panel-links`, `unlink`, `linear` (e2e).
- `link-pr-in-turn` an agent calls `link_pull_request` during a real turn and the panel updates live.
- `pr-status` each row's second line reads `<status> · [<review> · ]<title>`, the icon is colored by status, and a checks icon shows passing, failing or pending.
- `pr-create` `Create pull request` shows when the worktree is ready, `gh` is signed in, and the branch has no PR; it pushes the branch and runs `gh pr create --head <branch> --base <baseRef> --fill`.
- `gh-auth` Settings > Integrations > GitHub reads the signed-in, not-installed or not-signed-in state; the panel shows one hint instead of per-row errors when signed out.

- `request-secret` (service integration; real-turn UI recipe below) during a turn, `request_secret` shows a `<provider> asks for a secret` card with the description, the name and a masked input; Save stores the value (`secrets.has` turns true) and the tool returns the name only; Decline returns an error result; the card goes away either way. Outside a turn the tool fails with `No turn is running`.
- `create-thread` (service integration; real-turn UI recipe below) `create_thread` adds a thread to the caller's project; it shows in the sidebar without a reload, runs its prompt as the first turn, and `threads.list` shows `createdBy` as `thread:<caller>`.
- `thread-controls` (service integration) `list_threads` lists the non-archived threads of the caller's project and marks the caller; `read_thread` shows a thread's status, pending approvals or questions, and latest messages; `send_to_thread` starts a turn on an idle thread and steers a running one; `stop_thread` interrupts it. Threads of another project are refused, and send/stop refuse the caller itself.

## How to get to it (user POV)

- Users do not call the tools; they ask an agent to, for example `Open a PR and link it`, and see the result in the thread details panel under `Pull requests`.

## Driving it with agent-browser and mcp-call.mjs

Preconditions:

- Instance launched, doctor passes, project `demo` on `$DATA/repo`, a Claude thread `mcp check` (`Sonnet 5.5`) open with the panel visible. `gh` signed in for the status steps.
- `AB="agent-browser --session kkv-$PORT-mcp-and-pull-requests"`, connected.

- **Link from an agent turn.** Send `Call the hinacode link_pull_request tool with url https://github.com/hinadev-ai/hinacode/pull/1, nothing else.` If a `Claude Code needs your approval` card names `mcp__hinacode__link_pull_request`, click `Allow` (`--exact`). The tool row turns `Done` and, without a reload, `Pull requests` shows `hinadev-ai/hinacode#1`. Screenshot `mcp-and-pull-requests-01-linked-in-turn.png`.
- **Status.** Link real pull requests such as `https://github.com/hinadev-ai/hinacode/pull/32` (read-only), wait for each row's second line, and compare `$S/rpc.mjs $PORT github.pullRequest '{"url":"..."}'` with `gh pr view <n> -R hinadev-ai/hinacode --json title,state,isDraft,reviewDecision,statusCheckRollup,author,headRefName,baseRefName,additions,deletions`. Screenshot `mcp-and-pull-requests-02-status.png`.
- **Create without touching GitHub.** Give the seeded repo a bare `origin`, and launch with a `gh` shim first on `PATH` that logs `pr create` and prints a PR URL, answers `pr view <branch>` with `no pull requests found for branch` until then, and passes everything else to the real `gh`. Commit in the worktree, click `Create pull request`, and check the log for `pr create --head <branch> --base main --fill` run in the worktree. The new link appears through the push.
- **gh missing or signed out.** Launch with every `PATH` entry holding a `gh` removed, or with `GH_CONFIG_DIR` pointing at an empty directory and `GH_TOKEN`/`GITHUB_TOKEN` unset. `$S/rpc.mjs $PORT github.auth` prints `missing` or `signedOut`, Settings > Integrations shows the matching sentence, and the panel shows the single hint. Screenshot `mcp-and-pull-requests-03-gh-signed-out.png`.

- **Request a secret in a turn.** Read `TID` from `$S/rpc.mjs $PORT threads.list` first. Send `Call the hinacode request_secret tool with name demo.token and description "Demo API token for verification", then tell me whether it was stored. Nothing else.` Allow the tool if asked. A `Claude Code asks for a secret` card appears with `Stored as demo.token` and a `Secret value` password field. Screenshot `mcp-and-pull-requests-05-secret-card.png`. `$AB find label "Secret value" fill "verify-value"`, then `$AB find role button click --name "Save" --exact`. The card disappears, the tool row turns `Done`, and the assistant says it was stored. `$S/rpc.mjs $PORT secrets.has '{"name":"demo.token"}'` prints `true`; `$S/rpc.mjs $PORT threads.transcript "{\"threadId\":\"$TID\"}"` must not contain `verify-value`. Screenshot `-06-secret-stored.png`.
- **Create a thread.** Send `Call the hinacode create_thread tool with title "Child thread" and prompt "Reply with the single word pong.", then report the id. Nothing else.` The sidebar gains `Child thread` under `demo` while the first thread is still running. Screenshot `mcp-and-pull-requests-07-child-thread.png`. `$S/rpc.mjs $PORT threads.list` shows it with `createdBy` `thread:<TID>`.

## Gotchas

- The credential is per thread and changes on every launch. Re-read `mcp.connection` after `launch.sh`.
- Codex gates every hinacode tool call behind an approval card (MCP elicitation). See `chat-codex.md`.
- Never click `Create pull request` against a real GitHub remote while verifying; it opens a real pull request.
- `request_secret` waits for the user; Codex allows 600 seconds for this tool call.
- Real Linear calls hit the user's workspace. Only run the Linear tools with a key the user gave you for testing.
