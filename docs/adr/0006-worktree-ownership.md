# 0006. A worktree has one owner, and removal is refused while it is in use

Status: Accepted
Date: 2026-10-11

## Context

Issue #5: two threads on the same branch shared one checkout. Settling either thread force-removed the other's uncommitted work, even mid-turn. Folder names turned `/` into `-`, so `kk/fix` and `kk-fix` collided.

## Decision

- Worktrees live in `<parent>/.kkcode-worktrees/<project>/`, and each folder name ends with the worktree id.
- A branch has at most one live worktree (`WorktreeTakenError`).
- Removal fails with `WorktreeBusyError` while setup runs, while any thread in the checkout is mid-turn, or while another open thread uses it.
- Create, remove and turn start share one lock, so a removal can't land between a turn resolving its directory and starting in it.
- A removed worktree keeps its row. Every caller resolves the working directory through `makeActiveWorkspace`, which falls back to the project root (#18).
- A worktree still `preparing` at boot becomes `failed`. Setup scripts are never re-run without the user asking.

## Consequences

- The service enforces these rules, so a disabled button is not the only guard.
- The lock is held for the whole `git worktree remove`.
