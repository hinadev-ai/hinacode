# Activity bar and file explorer

Status: Building
Date: 2026-10-12

## Problem

A developer looking at a thread cannot see the files in its worktree without opening another editor. The Changes list shows what moved, but not where it sits in the tree, what is around it, or what the agent has not touched. Reading a file the agent wrote means switching to an editor and finding the worktree first.

The side panel also outgrew its tabs. Details carried the workspace, setup log, changes, ports and pull requests in one scroll, so a diff had to share room with everything else, and every new surface (files, a git graph) needed another tab and another branch in the panel code.

## User flow

1. Open a thread. The right edge shows the activity bar: Details, Files, Changes, Git, Pull requests and Agents, top to bottom. Agents carries a badge with the number of running subagents.
2. Click an icon or press its shortcut to show that view to the left of the bar, with focus inside it. Clicking the shown view's icon or pressing its shortcut again hides the panel. `mod+.` still shows and hides the panel. Each thread remembers its view; a thread opened for the first time shows the view picked last.
3. In the bar, Up and Down move between icons, Home and End jump, Enter or Space shows one. The tooltip names the view and its shortcut.
4. Files shows the thread's working directory: its worktree, or the project root. Folders come first, then files, sorted case-insensitively. `.git` is hidden.
5. Changed entries are colored and carry a letter: amber M modified, emerald A added or U untracked, red C conflict. A folder takes the color of what changed inside it. Gitignored entries are dimmed.
6. Keyboard, following the WAI-ARIA tree pattern: Up and Down move, Home and End jump, Right expands a folder or moves into it, Left collapses a folder or moves to its parent, typing letters jumps to the next entry whose name starts with them.
7. Enter or a click on a folder toggles it. Enter or a click on a file opens it below the tree: read-only, highlighted, with line numbers and horizontal scroll. The panel widens while a file is open. The split between tree and file can be dragged, or focused and moved with Up and Down. Escape in the tree or the viewer closes the file. The viewer reloads when the file changes on disk.
8. Right-click opens a menu: Mention in message, Show changes (changed files in a worktree, switches to the Changes view with that diff open), Copy path, Show in folder. The viewer header has Copy path and Close.
9. The Files header has Collapse all, Show in folder and Refresh. The tree updates by itself when files appear, disappear or change in an expanded folder, and when a turn ends.

### Shortcuts

| View          | Default       |
| ------------- | ------------- |
| Details       | `mod+shift+o` |
| Files         | `mod+shift+e` |
| Changes       | `mod+shift+d` |
| Git           | `mod+shift+g` |
| Pull requests | `mod+shift+m` |
| Agents        | `mod+shift+a` |

Details and Pull requests do not use `mod+shift+i` and `mod+shift+r`. hinacode keeps Electron's default menu, where `mod+shift+r` is Force Reload and `ctrl+shift+i` opens the developer tools outside macOS; the menu takes those keys before the page sees them. `mod+shift+p` and `mod+shift+f` stay free for the command palette and search.

## Design

### Activity bar

`src/renderer/components/sidePanel/views.ts` is a registry of `SidePanelView { id, icon, title, commandId, component, badge? }`, one entry per view in bar order. `ActivityBar` renders the entries as a vertical `role="tablist"` with roving focus; `ThreadSidePanel` renders the selected entry's component in a `role="tabpanel"` named after the view. Neither has a branch per view. A view that is not built yet, such as Git, is an entry whose component is a one-line empty state, so the git graph replaces one component.

`useUi` keeps `sidePanelViews` (thread id to view), `lastSidePanelView`, and `sidePanelWide`, which a view sets while it shows a file or a diff. The commands `view.details`, `view.files`, `view.changes`, `view.git`, `view.pullRequests` and `view.agents` call `toggleView`, which shows the view and asks it to take focus, or hides the panel when that view is already shown. Docked, the bar stays on screen while the view is hidden. In the narrow layout the bar and the view open together in the overlay.

### File explorer

Ported from Zed's project panel (`crates/project_panel/src/project_panel.rs`):

- **Taken:** a flat list of visible entries with a depth per row, rendered virtualized (`@legendapp/list`, fixed 24 px rows); per-directory lazy loading on expand; git status colors and dimmed ignored entries; folders aggregate their children's status; the keyboard model (`select_next`, `select_prev`, `expand_selected_entry` moving into an open folder, `collapse_selected_entry`, `select_parent`, open on Enter); indent guides; selection kept in view; a file opens in a read-only view next to the panel.
- **Changed:** Left on a file or collapsed folder selects the parent instead of collapsing the nearest open ancestor, which is what the ARIA tree pattern expects. Type-ahead comes from the ARIA pattern, Zed has no equivalent. The file opens inside the panel, below the tree, instead of in an editor pane.
- **Dropped:** rename, new file or folder, delete, cut, copy, paste and drag and drop; multi-select; several worktree roots in one panel; auto-folding single-child folders (`auto_fold_dirs`); sticky ancestor rows; editing.

### Data

`src/shared/domain.ts` adds `FsEntry { name, path, kind: "file" | "dir" | "symlink", ignored, gitStatus }` and `FsFileContent { content, truncated, binary }`. `path` is relative to the root, so it is what the composer mention and git use. `ChangedFileStatus` gains `conflict`, which `worktrees.changes` now also reports for unmerged paths.

### rpc and pushes

- `fs.list {root, path} -> FsEntry[]` returns one directory level. There is no recursive listing: `files.list` already serves `@` completion.
- `fs.read {root, path} -> FsFileContent` returns up to the first 1 MB. A NUL byte in the first 8000 bytes, git's own test, marks the file binary and sends no content.
- `fs.watch {root, paths}` replaces the set of watched directories for that root. The renderer sends the root, every expanded folder and the open file's parent folder, and an empty set when the thread view unmounts.
- Push `fs.changed {root, path}` fires 100 ms after the last change in a watched directory. The renderer re-lists that directory, and the viewer reads its file again when the file lives there.

### Main: `services/Files.ts`

- **Trust boundary.** `root` must equal a project `rootPath` or the path of a worktree that is not removed. `path` must be relative, must not contain a `..` segment, and its realpath must stay inside the root's realpath, so a symlink cannot lead out. Anything else fails with `FsAccessError`. `fs.list`, `fs.read` and `fs.watch` share this check. The containment check (`isInside` in `security.ts`) is shared with the attachment protocol.
- **Listing.** `readdir` with file types. Symlinks are leaves and are never followed.
- **Ignored.** One `git check-ignore --stdin -z` per listing, fed the listed folder and its entries. A folder inside an ignored folder is ignored as a whole.
- **Status.** `git status --porcelain -z --no-renames` limited to the listed folder gives untracked files, conflicts and uncommitted edits. In a worktree, `git diff --name-status` against the merge base with the base ref adds what the agent committed, so the colors agree with the Changes list. Paths are made relative to the root with `rev-parse --show-prefix`, which matters when a project root is a subfolder of its repository. Outside a git repository the listing has no status and nothing is ignored.
- **Reading.** One `read` of 1 MB plus one byte into a buffer, which tells a file of exactly 1 MB from a longer one without a `stat`.
- **Watching.** One non-recursive `fs.watch` per watched directory, closed when it leaves the set and when the runtime shuts down.

### Renderer

- `stores/explorer.ts` (zustand), keyed by root: `expanded`, `children` per folder, `selected`, `opened`. `flattenTree` turns that into the visible `{entry, depth}` rows.
- `components/FileExplorer.tsx` renders `role="tree"` with `aria-activedescendant`, and each row as `role="treeitem"` with `aria-level`, `aria-expanded`, `aria-selected`, `aria-setsize` and `aria-posinset`, so the virtualized rows still read as a tree. The split handle is a WAI-ARIA window splitter (`role="separator"` with `aria-valuenow`).
- `components/FileViewer.tsx` highlights with the `File` component of `@pierre/diffs`, the library that already renders `PatchDiff`. It shares the diff view's themes, Shiki grammars and font settings, and virtualizes long files through its `Virtualizer`, so no second highlighter ships. Content comes from `fileContentAtom`, keyed by root and path.
- Status colors are tokens (`--vcs-modified`, `--vcs-added`) in `index.css`, shared with the Changes list, with a letter beside each so color is never the only signal.

### Performance

Measured in the built app on a Mac with a 5,000-file folder: `fs.list` answers in about 42 ms including the `check-ignore` and `status` calls. With the folder expanded, the tree keeps about 50 rows in the DOM, and scrolling 60,000 px one step per frame gave a median frame of 8.3 ms, a 95th percentile of 10.0 ms and a worst frame of 10.7 ms on a 120 Hz display. A 1.2 MB file of 100,000 short lines opens truncated at 1 MB and highlighted after about 2.3 s; files of normal size open at once.

## Out of scope

- Editing the tree: rename, create, delete, move. Agents do that; the explorer shows it.
- Editing a file. Basic editing and line comments came later, see `2026-10-13-file-editing-and-line-comments.md`.
- Images and other binary files. The viewer says the file is binary and shows nothing.
- Deleted files. They are not on disk, so they are not listed; their folder shows as modified and the Changes list has the diff.
- Following symlinked folders.
- Hiding ignored files. They are dimmed, not removed.
- The git graph. The Git view is a placeholder until it lands in its own change.

## Verification

- `services/Files.integration.test.ts` runs against a temp git repo: sorting, kinds, `.git` hidden, ignored entries, status for modified, untracked and committed-in-worktree files, folder aggregation, and refusals for an unknown root, an absolute path, `..`, a symlink out of the root, and a removed worktree. `fs.read` covers a text file, a symlink inside the root, the 1 MB cap, a binary file, and refusals for an unknown root, `..`, an absolute path, a symlink to a file outside the root, a folder and a missing file. It also checks that a watched folder pushes `fs.changed`.
- `ipc.integration.test.ts` refuses `fs.list`, `fs.watch` and `fs.read` outside a known root over rpc.
- `security.test.ts` covers `isInside`. `stores/explorer.test.ts` covers `flattenTree`.
- `e2e/features/file-explorer.feature` opens Files with its shortcut, checks a modified and an ignored entry, opens a file with type-ahead and Enter, and closes it with Escape. The worktree, MCP and ports scenarios select their view in the activity bar.
- In the app: every view shortcut shows its view and hides it on a second press, `mod+.` hides and shows, an edit on disk reloads the open file, a binary file and a 1.2 MB file show their notes, and screenshots of the Files view with a file open in light and dark.
