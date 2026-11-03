# Explorer file operations and off-thread highlighting

Status: Shipped
Date: 2026-11-04

## Problem

The Files panel could show and edit files but not create, rename or delete them. A developer who wanted a scratch file next to the agent's work, or to fix a misnamed file, had to leave HinaCode for a terminal or another editor.

Opening a file also froze the window. The viewer highlighted the whole file on the main thread before it painted. In the built app on Linux, a 100 KB TypeScript file blocked input for 0.5 s, a 300 KB one for 1.3 s and a 950 KB one for 4.0 s.

## User flow

1. Two header buttons, New file and New folder, put a name field at the top of the target folder. The target is the selected folder, or the folder of the selected file, or the root when nothing is selected. Right-clicking a row offers the same two items.
2. Enter creates the entry. A new file opens in the viewer. Escape, or Enter on an empty name, cancels. Moving focus away creates the entry when the name is valid.
3. F2, or Rename in the context menu, turns the row's name into a field with the stem selected, so `notes` is selected in `notes.md`. Enter renames it. Expanded folders stay expanded, and an open file stays open under its new path.
4. Delete, Cmd+Backspace on macOS, or Delete… in the context menu asks for confirmation, with Cancel focused. Deleting removes the entry from disk permanently.
5. A name with `/`, `.` or `..`, or one that a sibling already uses, keeps the field open and shows the reason in a tooltip under it.
6. A file over 256 KB opens as plain text, with a note that it is shown without syntax highlighting. Smaller files open at once and get their colors a moment later.

## Design

Three rpc methods sit next to `fs.write` and are routed by `root`:

- `fs.create {root, path, kind}` makes an empty file (`wx`, never overwrites) or a folder (not recursive).
- `fs.rename {root, from, to}` refuses a target that exists, unless it is the same inode as the source, which allows a case-only rename on a case-insensitive disk.
- `fs.delete {root, path}` removes a file, a symlink or a folder with its contents.

`Files.resolveEntry` validates every segment the same way `resolveInside` does, then realpaths only the parent and joins the name. These operations act on the entry itself, so deleting or renaming a symlink never touches its target. A path that names the root, or contains `.git` anywhere, is refused with `outsideRoot`. An existing target fails with the new `exists` reason.

In the renderer, `ExplorerTree.naming` holds one of two states, creating in a folder or renaming a path. `flattenTree` turns a create into a `draft` row, so `TreeRow` is a union of entry and draft rows and both can render in the same virtual list. `afterRename` and `afterDelete` are pure functions that move or drop the expanded, selected, opened and unsaved paths under the changed entry. Unsaved edits under a renamed path are dropped, because the editor keys its buffer by path.

Highlighting uses the worker pool that `@pierre/diffs` ships. `HighlightWorkerPool` wraps the viewer with one worker, built by Vite from `@pierre/diffs/worker/worker.js?worker`, and passes the theme to it. The library's edit mode renders on the main thread and skips the pool, so the viewer opens read-only. It turns on editing when the pointer enters the code or the code gains focus. The pool runs with `useTokenTransformer`, the same options an edit session forces, so the editor adopts the worker's highlighted result instead of highlighting again. Editing starts before the first click, which lets that click place the caret.

## Out of scope

- Moving to the trash. The daemon has no trash, and a confirmed delete is what agents already do with `rm`. Git keeps tracked files recoverable.
- Drag and drop, cut, copy, paste, multi-select and creating nested paths such as `a/b/c.ts` in one step.
- A worker pool for the Changes diff and pull request views. They use the same library, but this change covers only the viewer.

## Verification

- `services/Files.integration.test.ts` covers create, rename and delete against a temp repo: files and folders, refusing existing names, case-only rename onto the same entry, symlinks removed or renamed without touching their targets, and refusals for `..`, absolute paths, the root, `.git` and a symlink that leaves the root.
- `stores/explorer.test.ts` covers the draft row's position and depth, and the path remapping after a rename or delete, including a sibling that shares a prefix such as `src` and `srcs`.
- In the app with `verify-hinacode`: create, rename (file, collapsed folder, expanded folder) and delete through the header, the context menu, F2 and Delete. The longest main-thread stall while opening the 100 KB, 300 KB and 950 KB files dropped to 50 ms or less, measured with a `MessageChannel` probe. Entering edit mode cost 69 ms, and the first click placed the caret.
