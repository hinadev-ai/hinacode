# Branch naming rules

Status: Shipped
Date: 2026-11-18

## Problem

Every worktree branch HinaCode created started with `kk/`, a leftover from the kkcode name, and no setting changed it (issue #972). On a team those branches reach the remote and pull requests under a prefix that means nothing to reviewers. Repositories with their own convention, such as this one's `feat/*` and `fix/*`, needed a manual rename on every thread. A fixed prefix setting would not cover that either, because the prefix depends on the task.

## User flow

1. Open Settings > Worktrees. Under the worktree root there is a Branch naming field that holds `Start with hinacode/.`
2. Replace it with rules in plain words, such as `Start with feat/ for features and fix/ for bug fixes.` The field saves when it loses focus.
3. Send the first message of a new worktree thread. The worktree starts on a placeholder branch, `hinacode/<title>`. When the text generation model names the thread, the branch is renamed to what it suggests under these rules, such as `fix/login-redirect`.

Clearing the field gives a bare name of 2 to 5 hyphenated words with no prefix.

## Design

- `Settings.branchNamingInstructions` is a string in `settings.json`, decoded with a default of `Start with hinacode/.`, so no migration.
- `ThreadNaming.suggest` keeps its base rule of 2 to 5 lowercase hyphenated words and appends the rules in a `<branch_naming>` block that may override it. It leaves the block out when the rules are blank. The model returns the whole branch name, and `slugifyBranch` still sanitizes it, keeping `/`.
- Names that never pass through the model use `hinacode/` directly. These are the placeholder branch (`Threads.attachWorktree`) and the local branch for a fork's pull request (`hinacode/pr-<number>`).

## Out of scope

- A per-project override. One global rule set covers the reported case, and the rules can name conditions. Add a project column when someone needs two repositories with conflicting conventions.
- Renaming existing branches. A fork pull request already checked out as `kk/pr-<number>` no longer matches `forkPullRequestBranch`, so Settle will not archive that thread on merge. Archive it by hand.

## Verification

- `ThreadNaming.integration.test.ts` checks that the default rules, custom rules and blank rules reach the model's system prompt, and that the suggested branch, slash included, becomes the worktree's branch.
- In the real app with `verify-hinacode`, change the field, reload Settings to see it persist, and start a worktree thread to see the branch follow the rules.
