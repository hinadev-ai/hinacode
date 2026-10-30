# Worktrees

A thread can run in its own git worktree. hinacode creates the branch and checkout, runs the project's setup script in it with `$HINACODE_ROOT_PATH`, `$HINACODE_WORKTREE_PATH` and `$HINACODE_BRANCH` set, streams the script's output into the side panel, lists the worktree's changes with diffs, and removes the worktree when the thread is archived with `Remove the worktree when archiving` on. The automated cases create the worktree through rpc without an agent turn. The composer creates it on the first send.

## Automated coverage

`e2e/features/worktrees.feature` creates threads with a worktree through rpc, then drives their panels. It covers the setup script running with `$HINACODE_ROOT_PATH` and `$HINACODE_BRANCH` and the log ending with its output, the copied `.env`, the branch and checkout in `git worktree list`, changed and untracked files with their diff after `Refresh diff`, a failing script ending in `Setup failed` with the exit code in the log, and archiving with worktree removal on removing the checkout while keeping a branch that has its own commit.

## Sub-features

- `setup-script`, `create` (rpc), `setup-log`, `changes`, `archive-cleanup` (e2e).
- `workspace-pick` ticking `Worktree` and the `Branch or pull request` target before the first send.
- `branch-rename` the first send renames the placeholder title and branch together.
- `from-pr` `#<n>` or a PR URL checks out the PR's head branch; a fork's PR lands on `kk/pr-<n>`.
- `sidebar-branch` shows the worktree branch under the thread row and marks it removed after archiving with worktree removal on.
- `setup-stop` `Stop setup` ends a running setup script.
- `settings-list` Settings > General > `Worktrees` lists every worktree with `Remove worktree <branch>`.
- `pr-badge` the `PR <state>` badge next to the branch comes from `gh pr view` for a branch with a pull request.

## How to get to it (user POV)

- `Add project` dialog, `Setup script` field.
- `New thread in <project>`, then tick `Worktree` under the composer and edit `Branch or pull request` (prefilled with the default branch, `origin/main` on a clone) before the first send. It takes a branch, a PR number such as `#98`, or a PR URL, and suggests open PRs and branches.
- Thread details panel (`Ctrl+.`): `Workspace`, `Setup log`, `Stop setup`. `Changes` is its own view (`Ctrl+Shift+D`) with `Refresh diff`.
- Archive from the sidebar row menu `Archive…` once Settings, Archive, `Remove the worktree when archiving` is on. Deleting a thread removes its worktree unless `Also remove its worktree, and its branch if merged` is unticked.

## Driving it with agent-browser

Preconditions:

- Instance launched, doctor passes, project `demo` on `$DATA/repo` with a setup script such as `sleep 30` for `setup-stop`.
- For `from-pr` and `pr-badge`: a project cloned from a GitHub repository with an open pull request, and `gh` signed in. This touches GitHub read-only.
- `AB="agent-browser --session kkv-$PORT-worktrees"`, connected.

- **Workspace pick (no turn).** Launch with `HINACODE_MOCK_CLAUDE=usage-limit`. Start a new thread, tick `Worktree`, keep the default branch, and send `ok`. `worktrees.list` reports the checkout while setup streams into the panel. Screenshot `worktrees-01-created.png`.
- **Stop setup.** On the `sleep 30` project, click `Stop setup` while the log waits. The status ends `Setup failed` and the panel reads `The setup script failed or was stopped. See the end of the log.`
- **Branch rename (one turn).** Without the mock, start a worktree thread and send `Reply with the single word: ok`. The placeholder title and branch change together, possibly before the reply; read the checkout path and branch from rpc before inspecting git.
- **From a pull request.** On the clone, with the usage-limit mock, type `#<n>` into `Branch or pull request` and send. The worktree checks out the PR's head branch tracking `origin` and links the PR; a PR URL of another repository is refused under the composer.
- **PR badge.** Open a thread on a worktree branch with a pull request. The `Workspace` row shows `PR open` linking to the pull request. Screenshot `worktrees-02-pr-badge.png`.
- **Settings list.** Settings > General lists the worktree under its project; `Remove worktree <branch>` asks, then removes the folder.

## Gotchas

- Nothing is created until the first send. Ticking `Worktree` and leaving the thread unsent leaves no branch or folder.
- Type into `Branch or pull request` after selecting its text through the DOM (`el.select()`), because `fill` may append to the prefilled branch.
- `Workspace` exists only before the first message; `Model` lists every agent whenever no turn runs.
- The setup script runs through `$SHELL -lc`, so the user's login profile runs first. A noisy profile shows up in the setup log.
- The worktree lives next to the project root, not inside it. Keep scratch repos inside `$DATA` so cleanup removes their worktrees too.
- A branch with no commits of its own counts as merged into the base ref, so archiving with worktree removal deletes it. The e2e scenario commits first to prove the other branch of that rule.
