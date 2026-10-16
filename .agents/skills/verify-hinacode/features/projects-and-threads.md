# Projects and threads

A user adds a local repository as a project, starts threads in it, and organizes them in the sidebar: threads are grouped under their project, can be collapsed, reordered by drag or keyboard, renamed inline, archived, unarchived and deleted, and filtered by text or by project. No agent turn is needed.

## Automated coverage

`e2e/features/projects.feature` and `e2e/features/threads.feature`: adding a project from a typed path, the not-a-folder and folder-already-used errors, creating a thread from the sidebar, opening it, collapsing and expanding a project group, keyboard reorder and its persistence, inline rename, archive and unarchive through the Archived tab, the Inbox order and its persistence, pin and unpin with persistence, the text filter and the project filter with its persistence, delete from the row menu, and projects and threads surviving a restart.

## Sub-features

- `project-add` (e2e) adds a project from a typed root path, with an optional setup script.
- `project-add-errors` (e2e) rejects a path that is not a folder and a folder another project already uses.
- `thread-new` (e2e) creates a thread immediately with a placeholder title and focuses the composer. `Ctrl+N` and the home page button open the palette's `+` project picker, with the open thread's project first and `Ctrl+1` to `Ctrl+9` per project; both are covered in `e2e/features/command-palette.feature`.
- `sidebar-inbox` (e2e) lists every project's active threads in one list, most recently updated first; the sidebar reopens on the last tab picked.
- `thread-pin` (e2e) pins a thread from the row menu into the `Pinned` region above the tabs and leaves it out of the tabs until it is unpinned.
- `sidebar-group` (e2e) lists threads under their project and collapses or expands the group.
- `thread-reorder` (e2e, keyboard) moves a thread within its project; pointer drag is the same sortable with a pointer sensor.
- `thread-rename` (e2e) renames a thread inline from the row menu.
- `thread-archive` (e2e) archives a thread from the row menu and brings it back from the Archived tab.
- `sidebar-filter` (e2e) narrows the sidebar by thread title or project name, and `Filter by project` keeps only the chosen projects across a restart.
- `thread-delete` (e2e) deletes a thread, its messages and PR links after confirmation.
- `persistence` (e2e) keeps all of the above across a relaunch.
- `thread-drag` reorders by dragging the row with the pointer.
- `project-browse` picks the root path with the native folder picker.

## How to get to it (user POV)

- Sidebar `Add project` button, the home page `Add project Ctrl+Shift+N` button, or `Ctrl+Shift+N`.
- Sidebar `New thread in <project>` button, the home page `New thread Ctrl+N` button, or `Ctrl+N` (uses the open thread's project, else the first project).
- Thread row: click the title link to open it; `Actions for <title>` opens `Rename`, `Pin` or `Unpin`, `Archive` (or `Archive…` when archiving removes worktrees), `Delete…`; `Reorder <title>` is the drag handle.
- `Show or hide threads in <project>` collapses a project group.
- Sidebar tabs `Inbox`, `Threads` and `Archived`, the `Pinned` region above them, the `Filter threads and projects` search field and the `Filter by project` menu. Archived rows have an `Unarchive <title>` button.
- There is no UI to edit or remove a project. `projects.update` and `projects.delete` exist only as rpc.

## Driving it with agent-browser

Preconditions:

- `$S/launch.sh $PORT $DATA` printed `hinacode ready` and `$S/doctor.sh $PORT $DATA` exits 0, `$S/seed-repo.sh $DATA/repo` done.
- `AB="agent-browser --session kkv-$PORT-projects-and-threads"`, connected. A project `demo` with threads `first`, `second`, `third` (create from the sidebar and rename, or seed with `rpc.mjs` and `$AB reload`).

- **Pointer drag.** Drag the row `third` above `first` with `$AB drag 'a[title="third"]' 'a[title="first"]'` (the pointer sensor activates after 4px). The links read third, first, second and `$S/rpc.mjs $PORT threads.list` shows `sortIndex` in that order. Screenshot `projects-and-threads-01-dragged.png`.
- **Native picker.** `Browse…` opens a GTK dialog that CDP cannot reach. Only a person at a real display can prove it; report it as not driven otherwise.

## Gotchas

- `find` does not wait. Every menu, select popup, inline input and dialog renders a frame or two after the click that opens it, so put an `$AB wait '<css>'` between opening and using it.
- Use `--exact` on every `find`. The open thread's row is a `button` named `<title> Reorder <title> Actions for <title>`, so a substring match on `Actions for <title>` clicks the row and opens the thread instead of the menu.
- Projects or threads seeded with `rpc.mjs` do not appear until `$AB reload`.
- Deleting a worktree thread leaves the worktree folder on disk (the dialog says so). Archiving removes it when the Archive setting `Remove the worktree when archiving` is on, see `worktrees.md`.
