# Worktree settings

Status: Building
Date: 2026-10-23

## Problem

Every thread that runs in a worktree leaves a checkout in the worktree root. A developer who keeps worktrees on archive, or deletes threads without removing them, ends up with dozens of checkouts and no place to see them. The only way to remove one is through its thread, and a checkout that is locked could not be removed at all.

## User flow

1. Settings, General, Worktrees lists every live worktree HinaCode manages, on this machine and on every paired cloud, grouped by project.
2. Each row shows the branch, the path, the threads that use it, and a badge when the checkout has uncommitted changes, is gone from disk, is still setting up, or failed setup.
3. Remove opens a confirmation. It names the branch and path and says uncommitted changes are lost for good. A dirty checkout gets the warning in the destructive color.
4. Confirming removes the checkout and the row disappears. Remove is disabled while a thread using the worktree runs a turn or its setup script runs, and the row shows why in a badge.

## Design

- `worktrees.list` (route `all`) already returns every worktree with its project and status. Projects, threads and clouds are already in the renderer stores, so the row needs no new data except the checkout state.
- `worktrees.checkouts` (route `all`) returns `{ id, state: "clean" | "dirty" | "missing" }` for every live worktree. It runs `git status --porcelain` in each checkout. A checkout git cannot read is left out, and its row shows no badge.
- Removal calls `worktrees.remove` with `deleteBranch: "ifMerged"` and no owner, which already ignores open threads and refuses only a running turn or setup.
- `git worktree remove` now passes `--force` twice, so a locked checkout is removed too. A dirty checkout and a missing directory already worked.

### Branch

Removal keeps the branch unless it is merged into the worktree's base ref. Uncommitted changes are what the user confirms losing. Commits on an unmerged branch survive, so a branch pushed for review or not yet pushed is never lost by cleaning up disk space.

### Threads

A thread whose worktree is removed keeps its transcript and runs its next turn in the project root, the same as after archiving with worktree removal. A running thread blocks removal, since deleting the directory under a running agent would break the turn halfway.

## Out of scope

- Checkouts git knows about that HinaCode has no row for. They are not ours to delete.
- Bulk removal. One confirmation per checkout keeps "uncommitted changes are lost" true for each.
- Deleting unmerged branches. Use git for that.

## Verification

- `Worktrees.integration.test.ts` "force removal" covers a dirty, a locked, a missing, and a locked and missing checkout.
- `verify-hinacode` with demo repos: open Settings, General, and remove a dirty worktree through the dialog.
