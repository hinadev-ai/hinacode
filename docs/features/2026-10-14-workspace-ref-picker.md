# Pick a branch or pull request for the first turn

Status: Building
Date: 2026-10-14

## Problem

A thread in the project root ran on whatever branch the root had checked out. The workspace pill showed that branch but could not change it, so working on another branch or someone's pull request meant switching in a terminal first. A new worktree forked from the local default branch, which is often days behind `origin`, so the agent started on stale code and the pull request later needed a rebase.

## User flow

1. A thread that has not started shows the workspace pill under the composer: a branch field and a Worktree checkbox.
2. With Worktree unticked, the field holds the root's current branch. Focusing it suggests open pull requests and branches, including `origin/*` branches that have no local copy. Typing `#123`, `123` or a pull request URL picks that pull request.
3. Sending the first message switches the project root to the pick. An `origin/x` pick gets a local `x` that tracks it. A pull request is fetched and checked out the same way a pull request worktree is, and linked to the thread. Leaving the current branch in the field changes nothing.
4. Ticking Worktree fills the field with `origin/main`, or whatever `origin/HEAD` names. The new `kk/<title>` branch forks from it and has no upstream, so the agent's first `git push -u origin HEAD` creates its own branch.
5. While the pill shows, hinacode fetches `origin` in the background, and again when the window comes back if the last fetch is more than five minutes old. The branch list refreshes when a fetch lands, so `origin/main` is at most a few minutes behind when the message is sent.

## Design

- `CheckoutTarget` is `branch { ref } | pullRequest { selector }`. `WorkspaceChoice` is `{ mode: "local" | "worktree", target }`. `threads.send` takes an optional `workspace: WorkspaceChoice`, and `Threads.prepareWorkspace` sets it up before the first turn.
- `Worktrees.checkout` and `Worktrees.checkoutPullRequest` run `git switch` in the root. They hold the same lock a turn takes to start, and refuse with `RootBusyError` while another thread's turn runs in the root, since switching would change its files mid-turn.
- `Worktrees.create` passes `--no-track` when it forks a new branch, so `origin/main` does not become its upstream. A pull request checkout keeps tracking `origin`.
- `projects.fetch` runs `git fetch origin` without `--prune`. A worktree's base ref can be a remote branch that has since been deleted, and pruning it would break that worktree's diff. In the renderer, `branchesAtom` and `defaultBranchAtom` read a fetch atom. They answer at once, then again when the fetch settles, so nothing waits on the network.
- `Worktrees.fetch` reaches `origin` at most once per project root every five minutes (`FETCH_INTERVAL`), through an Effect `Cache` that also holds a failed fetch for that long. Without it every window focus ran `git fetch` and the `gh` credential helper. Five minutes keeps a new worktree's base close to `origin` while capping the network calls at twelve an hour per project. `projects.fetch` returns the time of the fetch that last updated the refs, and `branchesAtom` and `defaultBranchAtom` rerun only when that time changes.
- This follows VS Code's autofetch, which runs `git fetch` every three minutes while the window has focus, and its "Create Branch From…", which uses `--no-track`. hinacode only needs `origin` to be fresh while a ref is being picked, so it fetches when the pill shows instead of on a timer.

## Out of scope

- Fast-forwarding a local branch that already exists and is behind its pull request, the same as for worktrees.
- Stashing or carrying uncommitted changes. `git switch` refuses when they conflict, and the composer shows its message.
- A periodic fetch for threads that have already started.

## Verification

- `Worktrees.integration.test.ts`, against a real bare `origin`, covers these cases. The root switches to a fetched `origin/*` branch and tracks it. A fork's pull request lands on `kk/pr-<n>` in the root. A switch is refused while another root thread runs. A new worktree forks from what `origin/main` has after a fetch, with no upstream. A second fetch inside `FETCH_INTERVAL` leaves the refs alone, and one after it updates them.
- `ThreadNaming.integration.test.ts` sends first messages through `workspace`.
- `verify-hinacode` covers the real app, with a fixture `origin` and a `gh` shim. It picks `origin/feature/login` in Local mode, then `#7`, then a worktree that defaults to a freshly pushed `origin/main`.
