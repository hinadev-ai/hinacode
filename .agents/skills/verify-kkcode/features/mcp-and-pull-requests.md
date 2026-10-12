# MCP tools and pull request links

kkcode runs one MCP server on 127.0.0.1 and hands each agent run a bearer credential bound to its thread; the credential alone decides which thread a call acts as. Agents use it to review their changes (`review_changes`), register the pull requests they open (`link_pull_request`, `list_thread_pull_requests`, `unlink_pull_request`), work with Linear (`linear_get_issue`, `linear_search_issues`, `linear_create_comment`, `linear_update_issue_state`), ask the user for a secret through a card in the thread (`request_secret`), and start sibling threads (`create_thread`). Linked pull requests appear in the thread's side panel with their status from `gh`, where the user can open or unlink them, and a worktree branch without a pull request offers `Create pull request`.

## Sub-features

- `tools-list` the server lists the ten tools above.
- `auth` a request with a wrong or missing token is rejected with 401 `invalid_token`.
- `review-changes` returns git status and diffs for the thread's workspace (and against the merge-base in a worktree).
- `link-pr` links a GitHub PR URL to the calling thread; non-PR URLs are rejected.
- `link-pr-in-turn` an agent calls `link_pull_request` during a real turn and the panel updates live.
- `panel-links` the `Pull requests` region lists `owner/repo#N` links, each opening the URL externally.
- `unlink` `Unlink owner/repo#N` removes a link from the panel.
- `pr-status` each row's second line reads `<status> · [<review> · ]<title>`, the icon is colored by status, and a checks icon shows passing, failing or pending (none when the PR has no checks). `github.pullRequest {"url":...}` returns the same.
- `pr-create` `Create pull request` shows when the thread's worktree is ready, `gh` is signed in, and the branch has no PR. It pushes the branch to `origin`, runs `gh pr create --head <branch> --base <baseRef> --fill` in the worktree, and links the result.
- `gh-auth` Settings > Integrations > GitHub reads `Signed in to github.com as <login>.`, `The GitHub CLI (gh) is not installed.`, or the `gh auth login` hint. When not signed in, the panel shows one hint instead of per-row errors.
- `linear` the Linear tools work with an API key stored in Settings > Integrations, and fail with a clear message without one.
- `request-secret` during a turn, `request_secret` shows a `<provider> asks for a secret` card with the description, the name and a masked input; Save stores the value (`secrets.has` turns true) and the tool returns the name only; Decline returns an error result; the card goes away either way. Outside a turn the tool fails with `No turn is running`.
- `create-thread` `create_thread` adds a thread to the caller's project; it shows in the sidebar without a reload, runs its prompt as the first turn, and `threads.list` shows `createdBy` as `thread:<caller>`.

## How to get to it (user POV)

- Users do not call the tools; they ask an agent to, for example `Open a PR and link it`, and see the result in the thread details panel under `Pull requests`.
- The panel region is always present in a thread; its empty state reads `None linked yet. Create one from this branch, or ask an agent to open one.`

## Driving it with agent-browser and mcp-call.mjs

Preconditions:

- Instance launched, doctor passes, project `demo` on `$DATA/repo`, a Claude thread `mcp check` (`Sonnet 5.5`), open in the window with the panel visible.
- `TID` holds its id (`$S/rpc.mjs $PORT threads.list`), `CONN=$($S/rpc.mjs $PORT mcp.connection "{\"threadId\":\"$TID\"}")`.
- `AB="agent-browser --session kkv-$PORT-mcp-and-pull-requests"`, connected.

- **Tools list.** `$S/mcp-call.mjs "$CONN" > "$SHOTS/mcp-and-pull-requests-01-tools.txt"` lists the ten tools.
- **Auth.** `curl -s -o /dev/null -w '%{http_code}\n' -X POST -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' -H 'authorization: Bearer wrong' --data '{}' "$(echo "$CONN" | jq -r .url)"` prints `401`. Save to `-02-auth.txt`.
- **Review changes.** `echo change >> $DATA/repo/README.md`, then `$S/mcp-call.mjs "$CONN" review_changes` prints `isError=false` and a diff containing `+change`.
- **Link from an agent turn.** In the composer send `Call the kkcode link_pull_request tool with url https://github.com/kjj6198/kkcode/pull/1, nothing else.` If a `Claude Code needs your approval` card names `mcp__kkcode__link_pull_request`, click `Allow` (`--exact`). The tool row turns `Done` and, without a reload, the `Pull requests` region shows `kjj6198/kkcode#1`. Screenshot `mcp-and-pull-requests-03-linked-in-turn.png`.
- **Invalid URL.** `$S/mcp-call.mjs "$CONN" link_pull_request '{"url":"https://example.com/not-a-pr"}'` prints `isError=true` and exits 1.
- **Panel link.** `$AB snapshot -i` shows a link `kjj6198/kkcode#1`; `$AB get attr @<ref> href` returns the URL. Do not click it: it opens an external browser.
- **Unlink.** `$AB find role button click --name "Unlink kjj6198/kkcode#1" --exact`. The region returns to its empty state. Screenshot `mcp-and-pull-requests-04-unlinked.png`. `$S/rpc.mjs $PORT pullRequests.list "{\"threadId\":\"$TID\"}"` prints `[]`.
- **Request a secret, no turn.** `$S/mcp-call.mjs "$CONN" request_secret '{"name":"demo.token","description":"x"}'` prints `isError=true` and `No turn is running on this thread.`
- **Request a secret in a turn.** Send `Call the kkcode request_secret tool with name demo.token and description "Demo API token for verification", then tell me whether it was stored. Nothing else.` Allow the tool if asked. A `Claude Code asks for a secret` card appears with `Stored as demo.token` and a `Secret value` password field. Screenshot `mcp-and-pull-requests-05-secret-card.png`. `$AB find label "Secret value" fill "verify-value"`, then `$AB find role button click --name "Save" --exact`. The card disappears, the tool row turns `Done`, and the assistant says it was stored. `$S/rpc.mjs $PORT secrets.has '{"name":"demo.token"}'` prints `true`; `$S/rpc.mjs $PORT threads.transcript "{\"threadId\":\"$TID\"}"` must not contain `verify-value`. Screenshot `-06-secret-stored.png`.
- **Create a thread.** Send `Call the kkcode create_thread tool with title "Child thread" and prompt "Reply with the single word pong.", then report the id. Nothing else.` The sidebar gains `Child thread` under `demo` while the first thread is still running. Screenshot `mcp-and-pull-requests-07-child-thread.png`. `$S/rpc.mjs $PORT threads.list` shows it with `createdBy` `thread:<TID>`.
- **Linear without a key.** `$S/mcp-call.mjs "$CONN" linear_get_issue '{"key":"ENG-1"}'` prints `isError=true` and `No Linear API key is configured. Ask the user to add one in kkcode Settings > Integrations, then retry.`

- **Status.** After linking real PRs such as `https://github.com/kjj6198/kkcode/pull/32` (read-only), wait for the second line of each row, then compare `$S/rpc.mjs $PORT github.pullRequest '{"url":"..."}'` with `gh pr view <n> -R kjj6198/kkcode --json title,state,isDraft,reviewDecision,statusCheckRollup`.
- **Create without touching GitHub.** Give the seeded repo a bare `origin` (`git init --bare`, `git remote add origin`, push `main`) and launch with a `gh` shim first on `PATH` that logs `pr create` and prints a PR URL, answers `pr view <branch>` with `no pull requests found for branch` until then, and passes everything else to the real `gh`. Commit in the worktree, click `Create pull request`, and check the log for `pr create --head <branch> --base main --fill` with the worktree as cwd.
- **gh missing or signed out.** Launch with every `PATH` entry holding a `gh` removed (mise installs it in several places), or with `GH_CONFIG_DIR` pointing at an empty directory and `GH_TOKEN`/`GITHUB_TOKEN` unset. `$S/rpc.mjs $PORT github.auth` prints `missing` or `signedOut`.

## Gotchas

- The credential is per thread and changes on every launch. Re-read `mcp.connection` after `launch.sh`.
- `mcp-call.mjs` proves the server contract; only the in-turn step proves an agent can reach it. Report both.
- Codex gates every kkcode tool call behind an approval card (MCP elicitation). See `chat-codex.md`.
- Linking the same URL twice keeps one link. The panel updates through a push event; if it does not change without `$AB reload`, that is a bug.
- Never click `Create pull request` against a real GitHub remote while verifying; it opens a real pull request.
- `request_secret` waits for the user. Codex times the call out after 600 s, the value configured for the kkcode server; a card left unanswered that long ends with an error result.
- Real Linear calls hit the user's workspace. Only run the Linear tools with a key the user gave you for testing.
