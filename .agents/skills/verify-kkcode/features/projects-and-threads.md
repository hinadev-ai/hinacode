# Projects and threads

A user adds a local repository as a project, starts threads in it, and organizes them in the sidebar: threads are grouped under their project, can be collapsed, reordered by drag or keyboard, renamed inline, settled and deleted. No agent turn is needed.

## Sub-features

- `project-add` adds a project from a typed root path, with an optional setup script.
- `project-add-errors` rejects a path that is not a folder and a folder another project already uses.
- `thread-new` creates a thread at once, with a placeholder title `thread-xxxxx`, agent `Claude Code` and its default model, opens it and focuses `Message`; from the sidebar, the home page or `Ctrl+N`.
- `sidebar-group` lists threads under their project and collapses or expands the group.
- `thread-reorder` moves a thread within its project by keyboard on the drag handle (pointer drag works too).
- `thread-rename` renames a thread inline from the row menu.
- `thread-settle` marks a thread settled from the row menu, the only place to settle.
- `thread-delete` deletes a thread, its messages and PR links after confirmation.
- `persistence` keeps all of the above across a relaunch.

## How to get to it (user POV)

- Sidebar `Add project` button, the home page `Add project Ctrl+Shift+N` button, or `Ctrl+Shift+N`.
- Sidebar `New thread in <project>` button, the home page `New thread Ctrl+N` button, or `Ctrl+N` (uses the open thread's project, else the first project).
- Thread row: click the title link to open it; `Actions for <title>` opens `Rename`, `Settle…`, `Delete…`; `Reorder <title>` is the drag handle.
- `Show or hide threads in <project>` collapses a project group.
- There is no UI to edit or remove a project. `projects.update` and `projects.delete` exist only as rpc.

## Driving it with agent-browser

Preconditions:

- `$S/launch.sh $PORT $DATA` printed `kkcode ready` and `$S/doctor.sh $PORT $DATA` exits 0.
- `$S/seed-repo.sh $DATA/repo` created the scratch repo.
- `SHOTS` is set as in SKILL.md, `AB="agent-browser --session kkv-$PORT-projects-and-threads"`, and `$AB connect $PORT` succeeded.
- The profile is fresh: the sidebar shows `No projects yet`.

- **Empty state.** Run `$AB screenshot "$SHOTS/projects-and-threads-01-empty.png"`. The sidebar reads `No projects yet`.
- **Invalid path.** Run `$AB find role button click --name "Add project" --exact` (the sidebar button), `$AB wait '[role=dialog]'`, `$AB find label "Root path" fill "/tmp/kk-does-not-exist"`, `$AB find label "Name" fill "demo"`, `$AB press Enter`. The dialog stays open with the alert `That path is not a folder. Pick an existing folder.`
- **Add project.** Run `$AB find label "Root path" fill "$DATA/repo"` and `$AB press Enter`, then `$AB wait --text "No threads yet"`. The sidebar shows `demo`. Screenshot `projects-and-threads-02-project-added.png`.
- **Duplicate path, keyboard entry.** Press `Control+Shift+N`, fill `Root path` with `$DATA/repo` and `Name` with `dup`, press `Enter`. The alert reads `Another project already uses this folder.` Click `Cancel` and wait for the dialog to unmount.
- **New thread, sidebar entry.** Run `$AB find role button click --name "New thread in demo" --exact` and `$AB wait 'textarea[aria-label=Message]'`. No dialog opens. The thread view shows a heading like `thread-1a2b3` (`T=$($AB get text h1)`), `Start the conversation`, the `Thread details` panel, and the composer with `Agent` reading `Claude Code`, `Model`, and `Workspace` reading `Local`. `$AB eval 'document.activeElement.getAttribute("aria-label")'` prints `"Message"`. The sidebar lists `$T` under `demo`. Screenshot `projects-and-threads-03-thread-created.png`.
- **Name it.** Rename `$T` to `first thread` from `Actions for $T` as in **Rename** below. The later steps rely on fixed titles; without a send the placeholder never changes on its own.
- **More threads, keyboard and home entry.** Press `Control+n` (a new `thread-xxxxx` opens with `Message` focused) and rename it `second thread`. Run `$AB reload` (back to home), click the home page button `New thread Ctrl+N` (`--exact`; it starts in the first project) and rename the result `third thread`.
- **Collapse.** Click `Show or hide threads in demo` (`--exact`). The thread links disappear and the button shows `expanded=false` in `$AB snapshot -i`. Click again to expand.
- **Reorder by keyboard.** Run `$AB focus 'button[aria-label="Reorder third thread"]'`, `$AB press Space`, `$AB press ArrowUp`, `$AB press ArrowUp`, `$AB press Space`. `$AB snapshot` contains `third thread dropped at position 1 of 3.` and the links now read third, first, second. Screenshot `projects-and-threads-04-reordered.png`.
- **Rename.** Click `Actions for second thread` (`--exact`), `$AB wait '[role=menu]'`, `$AB find role menuitem click --name "Rename" --exact`, `$AB wait 'input[aria-label="New name for second thread"]'`. Then `$AB fill 'input[aria-label="New name for second thread"]' "second thread renamed"` and `$AB press Enter`. `$AB wait --text "second thread renamed"` succeeds.
- **Settle.** Click `Actions for first thread`, `$AB wait '[role=menu]'`, menu item `Settle…`, `$AB wait '[role=alertdialog],[role=dialog]'`, then `$AB find role button click --name "Settle" --exact` in the dialog `Settle this thread?`. Open `first thread`: the header badge reads `Settled`. The sidebar row shows a check mark with the hidden label `Settled` in place of the status dot, and its menu no longer offers `Settle…`.
- **Delete.** Click `Actions for third thread`, menu item `Delete…`, `$AB wait '[role=alertdialog]'`. The alert dialog `Delete this thread?` quotes `“third thread”`. Screenshot `projects-and-threads-05-delete-dialog.png`, then `$AB find role button click --name "Delete thread" --exact` and `$AB wait --fn '!document.querySelector("[role=alertdialog]")'`. The row fades out; wait for it with `$AB wait --fn '![...document.querySelectorAll("nav a")].some(a => a.textContent.trim() === "third thread")'` before taking `projects-and-threads-06-after-delete.png`, or the shot catches it mid-fade.
- **Side effects.** Run `$S/rpc.mjs $PORT threads.list > "$SHOTS/projects-and-threads-07-threads.txt"`. It lists `first thread` with `"status": "settled"` and `second thread renamed` with `"status": "idle"`, no `third thread`, and `sortIndex` in sidebar order.
- **Persistence.** Run `$S/stop.sh $DATA`, `$S/launch.sh $PORT $DATA --no-build`, `$AB connect $PORT`. The sidebar shows `demo` with `first thread` then `second thread renamed`, and `first thread` still shows the `Settled` badge and sidebar mark. Screenshot `projects-and-threads-08-after-relaunch.png`.

## Gotchas

- `find` does not wait. Every menu, select popup, inline input and dialog renders a frame or two after the click that opens it, so put an `$AB wait '<css>'` between opening and using it. Skipping one leaves the UI half-open (for example the rename input stays focused) and the next several steps fail in confusing ways.
- Use `--exact` on every `find`. The open thread's row is a `button` named `<title> Reorder <title> Actions for <title>`, so a substring match on `Actions for <title>` clicks the row and opens the thread instead of the menu.
- There is no new thread dialog. Every entry point creates the thread immediately, so each click or `Ctrl+N` adds a row. Delete stray ones before asserting the sidebar order.
- Sending the first message renames the thread from its content in the background. Rename before sending when a recipe needs a fixed title, and re-read the `h1` after a send.
- The rename textbox opens with the old title selected, so `keyboard type` replaces it. Use `fill` with the full new name.
- `Browse…` opens a native folder picker that CDP cannot reach. Always type the path.
- There is no UI to edit or delete a project. Two projects may share a name but not a root path.
- Projects or threads seeded with `rpc.mjs` do not appear until `$AB reload`.
- Deleting a worktree thread leaves the worktree folder on disk (the dialog says so). Settling removes it, see `worktrees.md`.
- Right after a relaunch the composer model picker may show the raw id (`claude-sonnet-5-5`) until the model list loads; it then shows `Sonnet 5.5`.
