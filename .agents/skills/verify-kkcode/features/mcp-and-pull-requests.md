# MCP tools and pull request links

kkcode runs one MCP server on 127.0.0.1 and hands each agent run a bearer credential bound to its thread; the credential alone decides which thread a call acts as. Agents use it to review their changes (`review_changes`), register the pull requests they open (`link_pull_request`, `list_thread_pull_requests`, `unlink_pull_request`), and work with Linear. Linked pull requests appear in the thread's side panel with their status from `gh`, where the user can open or unlink them, and a worktree branch without a pull request offers `Create pull request`.

## Automated coverage

`e2e/features/mcp.feature` talks to the server with the real MCP SDK as the thread's agent: the tool list, a wrong credential getting 401, `review_changes` reporting a diff, `link_pull_request` showing up in the panel live and `Unlink` emptying it, a non-PR URL being refused, and the Linear tools explaining the missing key. `src/main/mcp/server.integration.test.ts` covers the credential rules in depth.

## Sub-features

- `tools-list`, `auth`, `review-changes`, `link-pr`, `panel-links`, `unlink`, `linear` (e2e).
- `link-pr-in-turn` an agent calls `link_pull_request` during a real turn and the panel updates live.
- `pr-status` each row's second line reads `<status> · [<review> · ]<title>`, the icon is colored by status, and a checks icon shows passing, failing or pending.
- `pr-create` `Create pull request` shows when the worktree is ready, `gh` is signed in, and the branch has no PR; it pushes the branch and runs `gh pr create --head <branch> --base <baseRef> --fill`.
- `gh-auth` Settings > Integrations > GitHub reads the signed-in, not-installed or not-signed-in state; the panel shows one hint instead of per-row errors when signed out.

## How to get to it (user POV)

- Users do not call the tools; they ask an agent to, for example `Open a PR and link it`, and see the result in the thread details panel under `Pull requests`.

## Driving it with agent-browser and mcp-call.mjs

Preconditions:

- Instance launched, doctor passes, project `demo` on `$DATA/repo`, a Claude thread `mcp check` (`Sonnet 5.5`) open with the panel visible. `gh` signed in for the status steps.
- `AB="agent-browser --session kkv-$PORT-mcp-and-pull-requests"`, connected.

- **Link from an agent turn.** Send `Call the kkcode link_pull_request tool with url https://github.com/kjj6198/kkcode/pull/1, nothing else.` If a `Claude Code needs your approval` card names `mcp__kkcode__link_pull_request`, click `Allow` (`--exact`). The tool row turns `Done` and, without a reload, `Pull requests` shows `kjj6198/kkcode#1`. Screenshot `mcp-and-pull-requests-01-linked-in-turn.png`.
- **Status.** Link real pull requests such as `https://github.com/kjj6198/kkcode/pull/32` (read-only), wait for each row's second line, and compare `$S/rpc.mjs $PORT github.pullRequest '{"url":"..."}'` with `gh pr view <n> -R kjj6198/kkcode --json title,state,isDraft,reviewDecision,statusCheckRollup`. Screenshot `mcp-and-pull-requests-02-status.png`.
- **Create without touching GitHub.** Give the seeded repo a bare `origin`, and launch with a `gh` shim first on `PATH` that logs `pr create` and prints a PR URL, answers `pr view <branch>` with `no pull requests found for branch` until then, and passes everything else to the real `gh`. Commit in the worktree, click `Create pull request`, and check the log for `pr create --head <branch> --base main --fill` run in the worktree. The new link appears through the push.
- **gh missing or signed out.** Launch with every `PATH` entry holding a `gh` removed, or with `GH_CONFIG_DIR` pointing at an empty directory and `GH_TOKEN`/`GITHUB_TOKEN` unset. `$S/rpc.mjs $PORT github.auth` prints `missing` or `signedOut`, Settings > Integrations shows the matching sentence, and the panel shows the single hint. Screenshot `mcp-and-pull-requests-03-gh-signed-out.png`.

## Gotchas

- The credential is per thread and changes on every launch. Re-read `mcp.connection` after `launch.sh`.
- Codex gates every kkcode tool call behind an approval card (MCP elicitation). See `chat-codex.md`.
- Never click `Create pull request` against a real GitHub remote while verifying; it opens a real pull request.
- Real Linear calls hit the user's workspace. Only run the Linear tools with a key the user gave you for testing.
