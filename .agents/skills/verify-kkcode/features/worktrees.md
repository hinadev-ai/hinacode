# Worktrees

A thread can run in its own git worktree. kkcode creates the branch and checkout, runs the project's setup script in it with `$KKCODE_ROOT_PATH`, `$KKCODE_WORKTREE_PATH` and `$KKCODE_BRANCH` set, streams the script's output into the side panel, lists the worktree's changes with diffs, and removes the worktree when the thread is settled. No agent turn is needed: edit files in the worktree from the shell to produce changes.

## Sub-features

- `setup-script` stores a setup script on the project and runs it in every new worktree with the three variables set.
- `create` makes branch `kk/<title-slug>` from the base ref (default: the project's current branch) at `<root parent>/.kkcode-worktrees/<root name>/<branch with / as ->`.
- `setup-log` streams output in the `Setup log` region; the workspace status goes `Preparing` then `Ready`, or `Setup failed` with the exit code at the end of the log.
- `changes` lists changed and untracked files against the base ref; clicking a file shows its unified diff; `Refresh changes` re-reads.
- `settle-cleanup` removes the worktree folder and deletes the branch only if it is merged into the base ref.
- `sidebar-branch` shows the worktree branch under the thread row and marks it removed after settle.

## How to get to it (user POV)

- `Add project` dialog, `Setup script` field.
- `New thread in <project>`, switch `Run in a new worktree`, then the `Branch` and `Base ref` fields.
- Thread details panel (toggle `Show thread details` / `Hide thread details`, or `Ctrl+.`): `Workspace`, `Setup log`, `Changes`, and the footer button `Settle and clean up`.
- Sidebar row menu `Settle…` opens the same settle dialog.

## Driving it with agent-browser

Preconditions:

- Instance launched, doctor passes, `$S/seed-repo.sh $DATA/repo` done (it leaves an untracked, gitignored `.env` containing `VERIFY_SECRET=from-root`).
- `AB="agent-browser --session kkv-$PORT-worktrees"`, connected.

- **Project with setup script.** Open `Add project`, fill `Root path` `$DATA/repo`, `Name` `wt`, and `$AB find label "Setup script" fill 'cp "$KKCODE_ROOT_PATH/.env" .env && echo "setup ok in $KKCODE_WORKTREE_PATH on $KKCODE_BRANCH"'`, then `Add project` (`--exact`). The script must keep its `$` literally; single-quote it in the shell.
- **Create a worktree thread.** Open `New thread in wt`, fill `Title` `wt check`, click the switch `Run in a new worktree`. `Branch` fills with `kk/wt-check` and `Base ref` with `main`. Screenshot `worktrees-01-new-thread-dialog.png`, then `Create thread`.
- **Setup log.** The panel `Workspace` shows `Preparing` then `Ready`, and `Setup log` ends with `setup ok in $DATA/.kkcode-worktrees/repo/kk-wt-check on kk/wt-check`. Screenshot `worktrees-02-setup-log.png`. Verify `cat $DATA/.kkcode-worktrees/repo/kk-wt-check/.env` prints `VERIFY_SECRET=from-root` and `git -C $DATA/repo worktree list` includes the path.
- **Changes and diff.** Run `echo change >> $DATA/.kkcode-worktrees/repo/kk-wt-check/README.md` and `echo new > $DATA/.kkcode-worktrees/repo/kk-wt-check/new.txt`, then `$AB find role button click --name "Refresh changes" --exact`. `Changes` lists `README.md` (modified) and `new.txt` (untracked) against `main`. Click `README.md`; the unified diff shows `+change`. Screenshot `worktrees-03-changes-diff.png`.
- **Setup failure.** Seed a second project with a failing script: `$S/rpc.mjs $PORT projects.create '{"name":"wt-fail","rootPath":"<a second seeded repo>","setupScript":"echo about to fail; exit 3"}'`, `$AB reload`, create a worktree thread in it. The status reads `Setup failed`, the log ends with the exit code, and the panel says `The setup script failed. See the exit code at the end of the log.` Screenshot `worktrees-04-setup-failed.png`.
- **Settle and clean up.** Back on `wt check`, click `Settle and clean up`. The dialog `Settle this thread?` names the worktree folder and says the branch `kk/wt-check` is deleted only if merged into `main`. Screenshot `worktrees-05-settle-dialog.png`, click `Settle and delete worktree`. The panel shows `The worktree was removed. New runs use the project root.` Screenshot `worktrees-06-removed.png`.
- **Side effects.** `ls $DATA/.kkcode-worktrees/repo/kk-wt-check` fails, `git -C $DATA/repo worktree list` no longer lists it, and `git -C $DATA/repo branch --list kk/wt-check` still prints the branch (it was not merged). Save the three outputs to `$SHOTS/worktrees-07-git.txt`.

## Gotchas

- The setup script runs through `$SHELL -lc`, so the user's login profile runs first. A noisy profile shows up in the setup log.
- The worktree lives next to the project root, not inside it. Keep scratch repos inside `$DATA` so cleanup removes their worktrees too.
- Deleting a worktree thread keeps the folder on disk; only settling removes it.
- A branch that already exists makes creation fail. Change `Branch` instead of reusing a name from an earlier run on the same repo.
- The `PR <state>` badge in `Workspace` comes from `gh` for the branch; with no GitHub remote there is none.
