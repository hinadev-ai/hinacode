# Worktrees

A thread can run in its own git worktree. kkcode creates the branch and checkout, runs the project's setup script in it with `$KKCODE_ROOT_PATH`, `$KKCODE_WORKTREE_PATH` and `$KKCODE_BRANCH` set, streams the script's output into the side panel, lists the worktree's changes with diffs, and removes the worktree when the thread is settled. No agent turn is needed.

## Automated coverage

`e2e/features/worktrees.feature`: the setup script running with the variables and the log ending with its output, the copied `.env`, the branch and checkout in `git worktree list`, changed and untracked files with their diff after `Refresh changes`, a failing script ending in `Setup failed` with the exit code in the log, and settle removing the checkout while keeping a branch that has its own commit.

## Sub-features

- `setup-script`, `create`, `setup-log`, `changes`, `settle-cleanup` (e2e).
- `sidebar-branch` (e2e, indirectly) shows the worktree branch under the thread row and strikes it through after settle.
- `pr-badge` the `PR <state>` badge next to the branch comes from `gh pr view` for a branch with a pull request; after a merge, `Settle and clean up` becomes the primary action and the panel says the pull request is merged.

## How to get to it (user POV)

- `Add project` dialog, `Setup script` field.
- `New thread in <project>`, switch `Run in a new worktree`, then the `Branch` and `Base ref` fields.
- Thread details panel (`Ctrl+.`): `Workspace`, `Setup log`, `Changes`, and the footer button `Settle and clean up`.

## Driving it with agent-browser

Preconditions:

- Instance launched, doctor passes, a project on a repository that has a GitHub remote and a branch with an open pull request, and `gh` signed in. This touches GitHub read-only.
- `AB="agent-browser --session kkv-$PORT-worktrees"`, connected.

- **PR badge.** Create a worktree thread on that branch (type its name into `Branch`; an existing branch is checked out as is). The `Workspace` row shows `PR open` linking to the pull request. Screenshot `worktrees-01-pr-badge.png`. For a merged pull request the footer button is the primary variant and the hint reads `The pull request is merged. Settle the thread to delete this worktree.`

## Gotchas

- The setup script runs through `$SHELL -lc`, so the user's login profile runs first. A noisy profile shows up in the setup log.
- The worktree lives next to the project root, not inside it. Keep scratch repos inside `$DATA` so cleanup removes their worktrees too.
- A branch with no commits of its own counts as merged into the base ref, so settle deletes it. The e2e scenario commits first to prove the other branch of that rule.
