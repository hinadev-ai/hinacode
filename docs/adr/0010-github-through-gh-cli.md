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
- Each linked PR polls `gh` every 60 s on its own. That's fine for a handful of PRs per thread. Batch through GraphQL if it ever isn't.
