# Projects and threads

A user adds a local repository (or clones one from GitHub) as a project, edits, groups or deletes it, starts threads in it, and organizes them in the sidebar: threads are grouped under their project, can be collapsed, reordered by drag or keyboard, renamed inline, archived, unarchived and deleted, and filtered by text or by project. No agent turn is needed.

## Automated coverage

`e2e/features/projects.feature` and `e2e/features/threads.feature`: adding a project from a typed path, a missing folder being created, the path-is-a-file and folder-already-used errors, creating a thread from the sidebar, opening it, collapsing and expanding a project group, keyboard reorder and its persistence, inline rename, archive and unarchive through the Archived tab, the Inbox order and its persistence, pin and unpin with persistence, snooze and unsnooze with persistence, copying a thread ID, the text filter and the project filter with its persistence, and delete from the row's `Delete <title>` button.

## Sub-features

- `project-add` (e2e) adds a project from a typed path, with an optional setup script; a missing folder is created.
- `project-add-errors` (e2e) rejects a path that is a file and a folder another project already uses.
- `thread-new` (e2e) creates a thread immediately with a placeholder title and focuses the composer. `Ctrl+N` and the home page button open the palette's `+` project picker, with the open thread's project first and `Ctrl+1` to `Ctrl+9` per project; both are covered in `e2e/features/command-palette.feature`.
- `sidebar-inbox` (e2e) lists every project's active threads in one list, most recently updated first; the sidebar reopens on the last tab picked.
- `thread-pin` (e2e) pins a thread from the row menu into the `Pinned` region above the tabs and leaves it out of the tabs until it is unpinned.
- `thread-snooze` (e2e) `Snooze…` hides a thread under `Snoozed` until a time; `Unsnooze` brings it back.
- `thread-copy-id` (e2e) `Copy thread ID` copies the id.
- `sidebar-group` (e2e) lists threads under their project and collapses or expands the group. The collapsed state is not kept across a relaunch.
- `thread-reorder` (e2e, keyboard) moves a thread within its project; pointer drag is the same sortable with a pointer sensor.
- `thread-rename` (e2e) renames a thread inline from the row menu.
- `thread-archive` (e2e) archives a thread from the row menu and brings it back from the Archived tab.
- `sidebar-filter` (e2e) narrows the sidebar by thread title or project name, and `Filter by project` keeps only the chosen projects across a restart.
- `thread-delete` (e2e) deletes a thread, its messages and PR links after confirmation; `Also remove its worktree, and its branch if merged` is on by default.
- `persistence` (e2e) keeps order, pins, snoozes and filters across a relaunch.
- `thread-drag` reorders by dragging the row with the pointer.
- `project-browse` picks the root path with the native folder picker.
- `project-edit` `Actions for <project>` > `Edit…` changes the name, `Root path` and setup script; `Delete…` removes the project; `Move to group` files it under a group.
- `project-clone` a GitHub repository typed into the Add dialog clones to `Clone to` with `Clone and add`.
- `new-chat` `New chat` starts a thread in the built-in `Chats` project, which needs no repository.

## How to get to it (user POV)

- Sidebar `Add project` button, the home page `Add project` button, or `Ctrl+Shift+N`. The dialog's path field is `Folder or GitHub repository`.
- Sidebar `New thread in <project>` button, which creates the thread at once. The home page `New thread` button and `Ctrl+N` open the palette's new-thread list, the open thread's project first, `Ctrl+1` to `Ctrl+9` per project.
- Sidebar `New chat`.
- Thread row: the row is a link that opens the thread; beside it are buttons `Reorder <title>` (the drag handle), `Archive <title>`, `Delete <title>` and `Actions for <title>`, whose menu has `Rename`, `Copy thread ID`, `Pin` or `Unpin`, `Snooze…` or `Unsnooze`, `Stop watching` while a PR is watched, `Archive` (or `Archive…` when archiving removes worktrees) and `Delete…`.
- Project row: `Actions for <project>` opens `New thread`, `Edit…`, `Move to group`, `Delete…`.
- `Show or hide threads in <project>` collapses a project group.
- Sidebar tabs `Inbox`, `Threads` and `Archived`, the `Pinned` region above them, the `Filter threads and projects` search field and the `Filter by project` menu. Archived rows have an `Unarchive <title>` button.

## Driving it with agent-browser

Preconditions:

- `$S/launch.sh $PORT $DATA` printed `hinacode ready` and `$S/doctor.sh $PORT $DATA` exits 0, `$S/seed-repo.sh $DATA/repo` done.
- `AB="agent-browser --session kkv-$PORT-projects-and-threads"`, connected. A project `demo` with threads `first`, `second`, `third` (create from the sidebar and rename, or seed with `rpc.ts` and `$AB reload`).

- **Pointer drag.** Drag the row `third` above `first` by its handle: `$AB drag 'button[aria-label="Reorder third"]' 'button[aria-label="Reorder first"]'` (the pointer sensor activates after 4px). The rows read third, first, second and `$S/rpc.ts $PORT threads.list` shows `sortIndex` in that order. Screenshot `projects-and-threads-01-dragged.png`.
- **Edit a project.** `$AB find role button click --name "Actions for demo" --exact`, wait for `[role=menu]`, click `Edit…`, change `Name` to `demo2`, `Save`. The sidebar group reads `demo2` and `projects.list` agrees. Screenshot `projects-and-threads-02-edited.png`.
- **New chat.** Click `New chat`; a thread opens under `Chats` with no `Workspace` group.
- **Clone.** Type a small public `owner/name` into `Folder or GitHub repository`, set `Clone to` under `$DATA`, `Clone and add`. Needs network; report it skipped otherwise.
- **Native picker.** `Browse…` opens a GTK dialog that CDP cannot reach. Only a person at a real display can prove it; report it as not driven otherwise.

## Gotchas

- `find` does not wait. Every menu, select popup, inline input and dialog renders a frame or two after the click that opens it, so put an `$AB wait '<css>'` between opening and using it.
- Use `--exact` on every `find`. `Actions for <title>` is a substring of other names (`Actions for <project>` when a thread shares the project's name), and `li:has(span[title=...])` matches the project's `li` too. Target the row's buttons by `aria-label`.
- Projects or threads seeded with `rpc.ts` do not appear until `$AB reload`.
- Deleting a worktree thread removes its worktree unless you untick `Also remove its worktree, and its branch if merged`. Archiving removes it when the Archive setting `Remove the worktree when archiving` is on, see `worktrees.md`.
- `Edit project` labels its path field `Root path`; the Add dialog labels it `Folder or GitHub repository`.
