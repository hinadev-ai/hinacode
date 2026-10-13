# Start a thread in a worktree from a branch or a pull request

Status: Shipped
Date: 2026-10-12

## Problem

Starting a thread in a worktree meant picking "New worktree" from a menu and typing a base ref, which defaulted to whatever the project root had checked out. That was often a feature branch, so new work forked from the wrong place. Working on someone's open pull request, to review it or answer its comments, meant checking the branch out by hand first.

## User flow

1. Under the composer of a thread that has not started, a pill shows the project root's branch and a Worktree checkbox.
2. Ticking Worktree turns the branch into a field filled with the repository's default branch (`origin/HEAD`, else `main`). Focusing it suggests open pull requests and branches.
3. The field takes a branch or ref to fork a new `kk/<title>` branch from, or a pull request as `123`, `#123` or its URL. The leading icon turns into a pull request icon when the text names one.
4. Sending the first message creates the worktree. A pull request's branch is checked out at its head and tracks `origin`, so the agent's pushes update the pull request, and the pull request is linked to the thread. A fork's pull request lands on a local `kk/pr-<number>` branch.

## Design

- The draft keeps the raw text, `worktree: { ref } | null`. On send, `parsePullRequestSelector` (shared) turns it into `WorktreeSource`, either `branch { baseRef }` or `pullRequest { selector }`, and `threads.send` validates it again.
- `Threads.attachWorktree` resolves a pull request with `gh pr view` and refuses one whose URL is not in the repository `origin` points at, since its head is fetched from `origin`.
- `Worktrees.createFromPullRequest` fetches `refs/heads/<head>` into `refs/remotes/origin/<head>`, or a fork's `refs/pull/<n>/head` into `refs/kkcode/pull/<n>`, and creates the worktree from it with the pull request's base as `baseRef`.
- First-message naming renames only the title of a thread already linked to a pull request when naming starts, which a pull request checkout is from its first send. Renaming its branch would leave it tracking the old upstream, so a plain `git push` fails and a new pull request would be opened instead.
- Suggestions come from two RPCs, `projects.branches` (git, instant) and `projects.pullRequests` (`gh pr list`, empty without `gh`), so branches never wait on the network.

## Out of scope

- Updating a local branch that already exists and is behind the pull request. `git worktree add` checks out the local branch as it is.
- Pushing back to a fork's pull request.

## Verification

- `ThreadNaming.integration.test.ts` sends a first message on a pull request checkout, a fork's, a resend after the checkout was attached, and a new-task branch, and checks which branches naming renamed.
- `Worktrees.integration.test.ts` checks out a same-repository pull request with its upstream set, a fork's pull request from `refs/pull/<n>/head`, and the branch suggestion order, against a real bare `origin`.
- In the real app, against a clone of this repository, threads were started from `main`, from `#98` and from a pull request URL, and a pull request of another repository was refused.
