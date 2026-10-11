# MCP tools and pull request links

kkcode runs one MCP server on 127.0.0.1 and hands each agent run a URL that names its thread and carries a per-process token. Agents use it to review their changes (`review_changes`), register the pull requests they open (`link_pull_request`, `list_thread_pull_requests`, `unlink_pull_request`), and work with Linear (`linear_get_issue`, `linear_search_issues`, `linear_create_comment`, `linear_update_issue_state`). Linked pull requests appear in the thread's side panel, where the user can open or unlink them.

## Sub-features

- `tools-list` the server lists the eight tools above.
- `auth` a request with a wrong or missing token is rejected with 401 `invalid_token`.
- `review-changes` returns git status and diffs for the thread's workspace (and against the merge-base in a worktree).
- `link-pr` links a GitHub PR URL to the calling thread; non-PR URLs are rejected.
- `link-pr-in-turn` an agent calls `link_pull_request` during a real turn and the panel updates live.
- `panel-links` the `Pull requests` region lists `owner/repo#N` links, each opening the URL externally.
- `unlink` `Unlink owner/repo#N` removes a link from the panel.
- `linear` the Linear tools work with an API key stored in Settings > Integrations, and fail with a clear message without one.

## How to get to it (user POV)

- Users do not call the tools; they ask an agent to, for example `Open a PR and link it`, and see the result in the thread details panel under `Pull requests`.
- The panel region is always present in a thread; its empty state reads `None linked yet. Agents add them with the link_pull_request tool.`

## Driving it with agent-browser and mcp-call.mjs

Preconditions:

- Instance launched, doctor passes, project `demo` on `$DATA/repo`, a Claude thread `mcp check` (`Sonnet 5.5`), open in the window with the panel visible.
- `TID` holds its id (`$S/rpc.mjs $PORT threads.list`), `URL=$($S/rpc.mjs $PORT mcp.url "{\"threadId\":\"$TID\"}" | tr -d '"')`.
- `AB="agent-browser --session kkv-$PORT-mcp-and-pull-requests"`, connected.

- **Tools list.** `$S/mcp-call.mjs "$URL" > "$SHOTS/mcp-and-pull-requests-01-tools.txt"` lists the eight tools.
- **Auth.** `curl -s -o /dev/null -w '%{http_code}\n' -X POST -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' --data '{}' "${URL/token=/token=wrong}"` prints `401`. Save to `-02-auth.txt`.
- **Review changes.** `echo change >> $DATA/repo/README.md`, then `$S/mcp-call.mjs "$URL" review_changes` prints `isError=false` and a diff containing `+change`.
- **Link from an agent turn.** In the composer send `Call the kkcode link_pull_request tool with url https://github.com/kjj6198/kkcode/pull/1, nothing else.` If a `Claude Code needs your approval` card names `mcp__kkcode__link_pull_request`, click `Allow` (`--exact`). The tool row turns `Done` and, without a reload, the `Pull requests` region shows `kjj6198/kkcode#1`. Screenshot `mcp-and-pull-requests-03-linked-in-turn.png`.
- **Invalid URL.** `$S/mcp-call.mjs "$URL" link_pull_request '{"url":"https://example.com/not-a-pr"}'` prints `isError=true` and exits 1.
- **Panel link.** `$AB snapshot -i` shows a link `kjj6198/kkcode#1`; `$AB get attr @<ref> href` returns the URL. Do not click it: it opens an external browser.
- **Unlink.** `$AB find role button click --name "Unlink kjj6198/kkcode#1" --exact`. The region returns to its empty state. Screenshot `mcp-and-pull-requests-04-unlinked.png`. `$S/rpc.mjs $PORT pullRequests.list "{\"threadId\":\"$TID\"}"` prints `[]`.
- **Linear without a key.** `$S/mcp-call.mjs "$URL" linear_get_issue '{"key":"ENG-1"}'` prints `isError=true` and `No Linear API key is configured. Ask the user to add one in kkcode Settings > Integrations, then retry.`

## Gotchas

- The token changes on every launch. Re-read `mcp.url` after `launch.sh`.
- `mcp-call.mjs` proves the server contract; only the in-turn step proves an agent can reach it. Report both.
- Codex gates every kkcode tool call behind an approval card (MCP elicitation). See `chat-codex.md`.
- Linking the same URL twice keeps one link. The panel updates through a push event; if it does not change without `$AB reload`, that is a bug.
- Real Linear calls hit the user's workspace. Only run the Linear tools with a key the user gave you for testing.
