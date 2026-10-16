# Diff and PR tabs

Status: Shipped
Date: 2026-10-12

## Problem

A developer who finishes reviewing a thread still has to leave hinacode for two things: reading what the agent changed, and getting the pull request merged. The Details tab listed changed files in a 24rem column next to the workspace, setup log and ports, and showed only the whole worktree diff. You could not see what the last turn alone touched. For a pull request it showed a one-line status. Failing CI, merge conflicts and merging all meant opening GitHub, and then coming back to type a prompt.

## User flow

1. Open a thread and the side panel (mod+.). The tabs are Details, Diff, PR and Agents.
2. Diff shows the worktree diff by default: everything the branch changed against its base ref, committed or not, new files included. A segmented control switches to Latest turn, which shows what changed since the most recent turn started. Root-workspace threads start on Latest turn, since they have no worktree diff. Each file row shows +/- counts and expands to the patch. The list refreshes when a turn starts or ends, when the window regains focus, and from the refresh button.
3. PR lists every pull request the thread has: the ones agents linked, plus the one GitHub has for the worktree branch. With more than one, a compact list sits on top and the picked one shows below. The worktree branch's PR is picked by default.
4. The detail shows title, state, review, `head → base`, checks, and the description rendered as markdown.
5. If checks fail, a red callout offers **Ask the agent to fix**. If the branch conflicts with its base, an amber callout offers **Ask the agent to resolve**. Each one sends a prompt into the thread, steering a running turn or starting one, and names the failing checks or the base branch.
6. **Squash and merge** is a split button, and its menu switches to a merge commit or a rebase. **Close pull request** sits next to it. Both confirm in a dialog first. Merging is disabled for drafts and conflicting branches, with the reason shown.

## Design

- Changes are computed by snapshotting the working tree into a tree object (`services/workingTree.ts`). The real index is copied to a temp file, then `git add -A` and `git write-tree` run against the copy. The diff is `git diff <base> <snapshot>`. One path serves both scopes and covers untracked files, which removed the old `ls-files` plus `--no-index` special case and the `untracked` file status.
  - Worktree scope: base is `merge-base(baseRef, HEAD)`.
  - Turn scope: `AgentRunner.startTurn` snapshots the cwd before the agent runs and stores the tree in `thread.turn_base_tree` (migration 0007). Steering does not take a new snapshot. A cwd that is not a git checkout stores null.
- rpc: `threads.changes({ threadId, scope })` returns `Changes | null`, where null means the scope has no base. It replaces `worktrees.changes`.
- rpc: `github.pullRequestDetail`, `github.merge` and `github.close` run `gh` from the home directory, so gh never touches a local checkout. Merge never passes `--delete-branch`, because the branch is checked out in a worktree.
- Trust boundary: those URLs come from the renderer and become `gh` argv. `requirePullRequestUrl` canonicalizes every one to `https://github.com/<owner>/<repo>/pull/<n>` first, so a value like `--admin` never reaches gh as a flag.
- The fix and resolve prompts are built in the renderer from the detail it already has, and sent with the existing `threads.steer`. No new rpc.

## Out of scope

- A resizable or wider side panel for long diffs.
- Inline review comments, or replying to review threads.
- Auto-merge, merge queues, and deleting the remote branch on merge. Archiving the thread can already remove the worktree and branch.
- Turn history beyond the latest turn.
- An unreferenced snapshot tree can be pruned by `git gc` after the prune window (two weeks by default). The Latest turn diff then shows an error until the next turn.

## Verification

- `workingTree.integration.test.ts` and `Worktrees.integration.test.ts` run real temp repos. They cover a modified, deleted, untracked and ignored file after a snapshot, and check that snapshotting leaves the real index alone.
- e2e `worktrees.feature` and `mcp.feature` drive the Diff and PR tabs.
- `GitHub.test.ts` covers `toPullRequestDetail` on a realistic `gh` payload, and checks that detail, merge and close reject a non-PR URL without spawning `gh`.
- In the real app (`verify-hinacode`), open a worktree thread, edit files, and switch the Diff scopes. Open the PR tab on a thread with a linked PR.
