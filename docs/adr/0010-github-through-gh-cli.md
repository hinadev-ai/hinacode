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
- Every window, paired device and background sweep asks about the same PRs, and they all share the user's GitHub budget with the agents' own `gh` runs. Reads of one PR therefore share one answer, fresh for 30 s while it is open and 10 min once it has merged or closed.
- PR reads run `gh api graphql --include` rather than `gh pr view`, because only `gh api` shows GitHub's `x-ratelimit-*` headers. Below a fifth of the GraphQL budget, open PRs stay fresh for 5 min and the windows get a warning. At zero, or on a `retry-after`, every `gh` call pauses until GitHub allows it again, and reads answer with the last known state.
- Other `gh` commands show no headers. When one fails on a rate limit, `gh api rate_limit`, which costs nothing, says when the used-up bucket resets. A secondary limit without `retry-after` pauses for a minute that doubles up to 15 min.
- If shared reads stop being enough, batch PRs into one GraphQL query through the same `gh api graphql` call.
