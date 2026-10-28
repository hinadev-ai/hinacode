# 0010. GitHub through the gh CLI

Status: Proposed (PR #35)
Date: 2026-10-12

## Context

hinacode called `gh` from three places and ignored its errors. A linked PR showed only its URL. The alternative is to take a token from `gh auth token` and call REST and GraphQL directly, with ETags, token caching, remote resolution and stacks.

## Decision

- A single `GitHub` service (`src/main/services/GitHub.ts`) owns every `gh` call: `gh pr view --json`, `gh auth status --json hosts` and `gh pr create`.
- Calls run with `GH_PROMPT_DISABLED=1`.
- A missing `gh` and a signed-out `gh` are typed errors.
- Checks are `null` when a PR has none, so a repo without CI never shows a green tick.
- Merging (`gh pr merge`) and dedicated GitHub MCP tools are excluded. Agents already run `gh` themselves.

## Consequences

- The user's existing `gh` login and config just work, with no tokens to store.
- Every window, paired device and background sweep asks about the same PRs, and they all share the user's GitHub budget with the agents' own `gh` runs. Reads of one PR therefore share one `gh pr view`, fresh for 30 s while it is open and 10 min once it has merged or closed.
- `gh` reports no rate limit headers, so a rate limit error is followed by `gh api rate_limit`, which costs nothing. Every `gh` call then pauses until the used-up bucket resets, or for a minute that doubles up to 15 min after a secondary limit. Reads answer with the last known state meanwhile.
- If shared reads stop being enough, batch PRs into one GraphQL query with a token from `gh auth token`.
