# Worktrees

A thread can run in its own git worktree. kkcode creates the branch and checkout, runs the project's setup script in it with `$KKCODE_ROOT_PATH`, `$KKCODE_WORKTREE_PATH` and `$KKCODE_BRANCH` set, streams the script's output into the side panel, lists the worktree's changes with diffs, and removes the worktree when the thread is archived with `Remove the worktree when archiving` on. The automated cases create the worktree through rpc without an agent turn. The composer creates it on the first send.

## Automated coverage

`e2e/features/worktrees.feature` creates threads with a worktree through rpc, then drives their panels and sidebar. It covers the setup script running with the variables and the log ending with its output, the copied `.env`, the branch and checkout in `git worktree list`, changed and untracked files with their diff after `Refresh changes`, a failing script ending in `Setup failed` with the exit code in the log, and archiving with worktree removal on removing the checkout while keeping a branch that has its own commit.

## Sub-features

- `setup-script`, `create` (rpc), `setup-log`, `changes`, `archive-cleanup` (e2e).
- `workspace-pick` and `branch-rename` need a real first turn; use the manual recipe below.
- `sidebar-branch` (e2e, indirectly) shows the worktree branch under the thread row and marks it removed after archiving with worktree removal on.
- `pr-badge` the `PR <state>` badge next to the branch comes from `gh pr view` for a branch with a pull request.

## How to get to it (user POV)

- `Add project` dialog, `Setup script` field.
- `New thread in <project>`, then tick `Worktree` under the composer and edit `Branch or pull request` (prefilled with the default branch) before the first send. It takes a branch, a PR number such as `#98`, or a PR URL, and suggests open PRs and branches.
- Thread details panel (`Ctrl+.`): `Workspace`, `Setup log`, `Changes`. Archive from the sidebar row menu `Archive…` once Settings, Archive, `Remove the worktree when archiving` is on.

## Driving it with agent-browser

Preconditions:

- Instance launched, doctor passes, a project on a repository that has a GitHub remote and a branch with an open pull request, and `gh` signed in. This touches GitHub read-only.
- `AB="agent-browser --session kkv-$PORT-worktrees"`, connected.

- **Composer creation and naming.** Start a new thread, tick `Worktree`, keep `main` in `Branch or pull request`, and send `Reply with the single word: ok`. `worktrees.list` reports the checkout while setup streams into the panel. After the reply, the placeholder title and branch change together; read the checkout path and branch from rpc before inspecting git.
- **PR badge.** Open a thread on a worktree branch with a pull request. The `Workspace` row shows `PR open` linking to the pull request. Screenshot `worktrees-01-pr-badge.png`.

## Gotchas

- Nothing is created until the first send. Ticking `Worktree` and leaving the thread unsent leaves no branch or folder.
- **From a pull request.** Use a project cloned from a GitHub repo with open PRs and start the app with `KKCODE_MOCK_CLAUDE=usage-limit`, so the send creates the worktree without a real turn. `#<n>` or the PR URL checks out the PR's head branch tracking `origin` and links the PR; a PR URL of another repository is refused with an error under the composer. Type into the field after selecting its text through the DOM (`el.select()`), because `fill` may append to the prefilled `main`.
- `Workspace` exists, and `Model` lists every agent, only before the first message. To test them again, start a new thread.
- The setup script runs through `$SHELL -lc`, so the user's login profile runs first. A noisy profile shows up in the setup log.
- The worktree lives next to the project root, not inside it. Keep scratch repos inside `$DATA` so cleanup removes their worktrees too.
- A branch with no commits of its own counts as merged into the base ref, so archiving with worktree removal deletes it. The e2e scenario commits first to prove the other branch of that rule.
