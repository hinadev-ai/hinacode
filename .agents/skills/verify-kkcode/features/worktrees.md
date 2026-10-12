# Worktrees

A thread can run in its own git worktree. The user picks `New worktree` in the composer before the first message; the first send creates the branch and checkout, runs the project's setup script in it with `$KKCODE_ROOT_PATH`, `$KKCODE_WORKTREE_PATH` and `$KKCODE_BRANCH` set, streams the script's output into the side panel, and starts the turn there. kkcode then renames the branch from the first message, lists the worktree's changes with diffs, and removes the worktree when the thread is settled. One cheap agent turn creates the worktree; after that, edit files from the shell to produce changes.

## Sub-features

- `setup-script` stores a setup script on the project and runs it in every new worktree with the three variables set.
- `workspace-pick` the composer's `Workspace` combobox (`Local` / `New worktree`) and the `Base ref` input, shown only before the first message.
- `create` on first send makes branch `kk/<placeholder title>` (for example `kk/thread-1a2b3`) from the base ref (empty means the project's current branch) at `<root parent>/.kkcode-worktrees/<root name>/<branch with / as ->-<id prefix>`.
- `branch-rename` after the first send a background model call renames the thread and the branch to `kk/<slug>`; the checkout path keeps the placeholder name.
- `setup-log` streams output in the `Setup log` region; the workspace status goes `Preparing` then `Ready`, or `Setup failed` with the exit code at the end of the log.
- `changes` lists changed and untracked files against the base ref; clicking a file shows its unified diff; `Refresh changes` re-reads.
- `settle-cleanup` removes the worktree folder and deletes the branch only if it is merged into the base ref.
- `sidebar-branch` shows the worktree branch under the thread row and marks it removed after settle.

## How to get to it (user POV)

- `Add project` dialog, `Setup script` field.
- A new thread (`New thread in <project>` or `Ctrl+N`), then under the composer the `Workspace` combobox set to `New worktree`, then the `Base ref` textbox (its placeholder is the project's current branch).
- Thread details panel (toggle `Show thread details` / `Hide thread details`, or `Ctrl+.`): `Workspace`, `Setup log`, `Changes`.
- Sidebar row menu `Actions for <title>` > `Settle…` opens the settle dialog. It is the only way to settle.

## Driving it with agent-browser

Preconditions:

- Instance launched, doctor passes, `$S/seed-repo.sh $DATA/repo` done (it leaves an untracked, gitignored `.env` containing `VERIFY_SECRET=from-root`).
- The `claude` CLI is logged in; the first send is a real turn.
- `AB="agent-browser --session kkv-$PORT-worktrees"`, connected.

- **Project with setup script.** Open `Add project`, fill `Root path` `$DATA/repo`, `Name` `wt`, and `$AB find label "Setup script" fill 'cp "$KKCODE_ROOT_PATH/.env" .env && echo "setup ok in $KKCODE_WORKTREE_PATH on $KKCODE_BRANCH"'`, then `Add project` (`--exact`). The script must keep its `$` literally; single-quote it in the shell.
- **Pick a worktree.** Click `New thread in wt` (`--exact`), `$AB wait 'textarea[aria-label=Message]'`, `T=$($AB get text h1)` (for example `thread-1a2b3`). Pick `Model` `Sonnet 5.5`. Pick `Workspace` > `New worktree` with the keyboard: `$AB focus 'button[aria-label="Workspace"]'`, `$AB press Enter`, `$AB press ArrowDown`, `$AB press Enter`. The `Base ref` textbox appears, empty, with placeholder `main`. Screenshot `worktrees-01-workspace-picker.png`.
- **Create on first send.** Fill `Message` with `Reply with the single word: ok`, press `Enter`. `Agent` and `Workspace` disappear from the composer. `$S/rpc.mjs $PORT worktrees.list` shows a row with `"branch": "kk/$T"` and `"baseRef": "main"`; save its `path` as `WT`.
- **Setup log.** The panel `Workspace` shows `Preparing` then `Ready`, and `Setup log` ends with `setup ok in $WT on kk/$T`. Screenshot `worktrees-02-setup-log.png`. Verify `cat $WT/.env` prints `VERIFY_SECRET=from-root` and `git -C $DATA/repo worktree list` includes `$WT`.
- **Branch rename.** After the reply, wait until the heading no longer reads `$T` (`$AB wait --fn "document.querySelector('h1').textContent !== '$T'"`). `worktrees.list` now shows `"branch": "kk/<slug>"` with the same `path`; save it as `BR`. `git -C $DATA/repo branch --list "kk/$T"` prints nothing. Screenshot `worktrees-03-renamed.png`. If naming fails the placeholder names stay; report it.
- **Changes and diff.** Run `echo change >> $WT/README.md` and `echo new > $WT/new.txt`, then `$AB find role button click --name "Refresh changes" --exact`. `Changes` lists `README.md` (modified) and `new.txt` (untracked) against `main`. Click `README.md`; the unified diff shows `+change`. Screenshot `worktrees-04-changes-diff.png`.
- **Setup failure.** Seed a second project with a failing script: `$S/rpc.mjs $PORT projects.create '{"name":"wt-fail","rootPath":"<a second seeded repo>","setupScript":"echo about to fail; exit 3"}'`, `$AB reload`, start a thread in it, pick `New worktree`, send a short message. The status reads `Setup failed`, the log ends with the exit code, and the panel says `The setup script failed. See the exit code at the end of the log.` Screenshot `worktrees-05-setup-failed.png`.
- **Settle and clean up.** Click `Actions for <renamed title>` (`--exact`), `$AB wait '[role=menu]'`, menu item `Settle…`, `$AB wait '[role=alertdialog],[role=dialog]'`. The dialog `Settle this thread?` names `$WT` and says the branch `$BR` is deleted only if merged into `main`. Screenshot `worktrees-06-settle-dialog.png`, click `Settle and delete worktree`. The panel shows `The worktree was removed. New runs use the project root.` Screenshot `worktrees-07-removed.png`.
- **Side effects.** `ls $WT` fails, `git -C $DATA/repo worktree list` no longer lists it, and `git -C $DATA/repo branch --list "$BR"` still prints the branch (it was not merged). Save the three outputs to `$SHOTS/worktrees-08-git.txt`.

## Gotchas

- Nothing is created until the first send. Picking `New worktree` and leaving the thread unsent leaves no branch or folder.
- `Workspace` and `Agent` exist only before the first message. To test them again, start a new thread.
- Composer selects can open upward under the header; drive them with the keyboard as above rather than clicking options.
- The setup script runs through `$SHELL -lc`, so the user's login profile runs first. A noisy profile shows up in the setup log.
- The worktree lives next to the project root, not inside it. Keep scratch repos inside `$DATA` so cleanup removes their worktrees too.
- The checkout path keeps the placeholder branch name after the rename. Read paths from `worktrees.list`, do not derive them from the title.
- Deleting a worktree thread keeps the folder on disk; only settling removes it.
- The `PR <state>` badge in `Workspace` comes from `gh` for the branch; with no GitHub remote there is none.
