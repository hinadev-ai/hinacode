# Projects and threads

A user adds a local repository (or clones one from GitHub) as a project, edits, groups or deletes it, opens a project's draft thread, and organizes them in the sidebar: threads are grouped under their project, can be collapsed, reordered by drag or keyboard, renamed inline, archived, unarchived and deleted, and filtered by text or by project. No agent turn is needed.

## Automated coverage

`e2e/features/projects.feature` and `e2e/features/threads.feature`: adding a project from a typed path, a missing folder being created, the path-is-a-file and folder-already-used errors, starting a thread opens a draft kept out of the sidebar, starting again brings the draft back, collapsing and expanding a project group, keyboard reorder and its persistence, inline rename, archive and unarchive through the Archived tab, the Inbox order and its persistence, pin and unpin with persistence, snooze and unsnooze with persistence, copying a thread ID, the text filter and the project filter with its persistence, archive Undo on the toast, a row menu opened before hover registers, and delete from the row menu's `Delete…` popover.

## Sub-features

- `project-add` (e2e) adds a project from a typed path, with an optional setup script; a missing folder is created.
- `project-add-errors` (e2e) rejects a path that is a file and a folder another project already uses.
- `thread-new` (e2e) opens the project's one draft, titled `New thread`, out of the sidebar until the first send, and focuses the composer. `Ctrl+N`, the sidebar's top `New thread` row and the home page button open the palette's project picker, with the open thread's project first and `Ctrl+1` to `Ctrl+9` per project (`e2e/features/command-palette.feature`).
- `sidebar-inbox` (e2e) lists every project's active threads in one list, most recently updated first; the sidebar reopens on the last tab picked, `Threads` on a fresh profile.
- `thread-pin` (e2e) pins a thread from the row menu into the `Pinned` region above the tabs and leaves it out of the tabs until it is unpinned.
- `thread-snooze` (e2e) `Snooze…` hides a thread under `Snoozed` until a time; `Unsnooze` brings it back.
- `thread-copy-id` (e2e) `Copy thread ID` copies the id.
- `sidebar-group` (e2e) lists threads under their project and collapses or expands it. A project's collapsed state is not kept across a relaunch; a user group's is.
- `thread-reorder` (e2e, keyboard) moves a thread within its project. The `Reorder <title>` handle is visible only with keyboard focus.
- `thread-rename` (e2e) renames a thread inline from the row menu.
- `thread-archive` (e2e) archives a thread from the row menu and brings it back from the Archived tab.
- `sidebar-filter` (e2e) narrows the sidebar by thread title or project name, and `Filter by project` keeps only the chosen projects across a restart.
- `thread-delete` (e2e) deletes a thread, its messages and PR links after confirmation; `Also remove its worktree, and its branch if merged` is on by default.
- `persistence` (e2e) keeps order, pins, snoozes and filters across a relaunch.
- `thread-drag` reorders by dragging the row link with the pointer (the drag starts after 4px).
- `project-browse` picks the root path with the native folder picker.
- `project-edit` `Actions for <project>` > `Edit…` changes `Root path`, `Name`, `Setup script` and `Open pull requests on linear.review`; `Delete…` removes the project.
- `project-group` `Actions for <project>` > `Move to group` > `New group…` files it under a user group; the group's `Actions for <group>` has `Rename…`, `Move up`, `Move down` and `Delete group`.
- `project-clone` a GitHub repository typed into the Add dialog clones to `Clone to` with `Clone and add`.
- `new-chat` `New thread in Chats` opens a draft in the built-in `Chats` project, which needs no repository and has no `Workspace` group or project menu.

## How to get to it (user POV)

- `Add project` next to the `Projects` heading in the `Threads` tab, the home page `Add project` button, or `Ctrl+Shift+N`. The dialog's path field is `Folder or GitHub repository`; it also has `Create GitHub repository`. Saving opens a draft in the new project.
- Sidebar `New thread in <project>` opens that project's draft. The sidebar's top `New thread` row, the home page `New thread` button and `Ctrl+N` open the palette's new-thread list.
- Sidebar `New thread in Chats`.
- Thread row: the row is a link that opens the thread; beside it are buttons `Reorder <title>` (the drag handle), `Snooze <title>`, `Archive <title>` and `Actions for <title>`, whose menu (also on right-click) has `Rename`, `Pin` or `Unpin`, `Snooze…`, `Unsnooze` while snoozed, `Stop watching` (disabled when nothing is watched), `Copy thread ID`, `Archive` or `Unarchive`, and `Delete…`. Archive asks first (`Archive and delete worktree`) only when the worktree is dirty, and its toast offers `Undo`.
- Project row (folder projects only): `Actions for <project>`, or right-click, opens `Move to group`, `Edit…`, `New thread`, `Import session…`, `Open with`, `Delete…`.
- `Show or hide threads in <project>` collapses a project group.
- Sidebar tabs `Inbox` and `Threads`, with settled and archived threads in folds fixed at the bottom of the Inbox, the `Pinned` region above them, the `Filter threads and projects` search field and the `Filter by project` menu. Archived rows have an `Unarchive <title>` button.

## Driving it with agent-browser

Preconditions:

- `$S/launch.sh $PORT $DATA` printed `hinacode ready` and `$S/doctor.sh $PORT $DATA` exits 0, `$S/seed-repo.sh $DATA/repo` done.
- `ab() { agent-browser --session kkv-$PORT-projects-and-threads --cdp $PORT "$@"; }`. A project `demo` with threads `first`, `second`, `third`. A draft has no sidebar row to rename, so seed them: `threads.create` then `threads.update '{"id":"<id>","title":"first"}'` for each, then `ab reload`.

- **Pointer drag.** Drag the row link, not the handle, which is a clipped 1px box without keyboard focus: `ab drag 'a:has(span[title="third"])' 'a:has(span[title="first"])'`. The rows read third, first, second and `$S/rpc.ts $PORT threads.list` shows `sortIndex` 0, 1, 2 in that order. Screenshot `projects-and-threads-01-dragged.png`.
- **Edit a project.** `ab find role button click --name "Actions for demo" --exact`, `ab wait '[role=menu]'`, `ab find role menuitem click --name "Edit…" --exact`, `ab wait '[role=dialog]'`, `ab find label "Name" fill demo2`, `ab find role button click --name "Save" --exact`. The sidebar reads `demo2` and `projects.list` agrees. Screenshot `projects-and-threads-02-edited.png`.
- **Group.** `Actions for demo2` > `Move to group` (a submenu) > `New group…`, `ab wait '[role=dialog]'`, `ab fill '[role=dialog] input' G1`, `Create`. `demo2` now sits under `G1`. Screenshot `projects-and-threads-03-grouped.png`.
- **Chats draft.** `ab find role button click --name "New thread in Chats" --exact`; `ab get text h1` is `New thread`, there is no `[aria-label=Workspace]` and no new sidebar row.
- **Clone.** Type a small public `owner/name` into `Folder or GitHub repository`, set `Clone to` under `$DATA`, `Clone and add`. Needs network; report it skipped otherwise.
- **Native picker.** `Browse…` opens a GTK dialog (Linux) or Cocoa sheet (macOS) that CDP cannot reach. Only a person at a real display can prove it; report it as not driven otherwise.

## Gotchas

- `find` does not wait. Every menu, select popup, inline input and dialog renders a frame or two after the click that opens it, so put an `ab wait '<css>'` between opening and using it.
- Use `--exact` on every `find`. `Actions for <title>` is a substring of other names (`Actions for <project>` when a thread shares the project's name), and `li:has(span[title=...])` matches the project's `li` too. Target the row's buttons by `aria-label`.
- Projects or threads seeded with `rpc.ts` do not appear until `ab reload`.
- Deleting a worktree thread removes its worktree unless you untick `Also remove its worktree, and its branch if merged`. Archiving removes it when Settings > Worktrees `Remove the worktree when archiving` is on, see `worktrees.md`.
- `Edit project` labels its path field `Root path`; the Add dialog labels it `Folder or GitHub repository`.
