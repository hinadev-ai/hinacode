# File explorer

Status: Building
Date: 2026-10-12

## Problem

A developer looking at a thread cannot see the files in its worktree without opening another editor. The Changes list shows what moved, but not where it sits in the tree, what is around it, or what the agent has not touched. Pointing the agent at a file means typing its path from memory.

## User flow

1. Open a thread. The side panel has a third tab, Files. `mod+shift+e` opens the panel on that tab and focuses the tree.
2. The tree shows the thread's working directory: its worktree, or the project root. Folders come first, then files, sorted case-insensitively. `.git` is hidden.
3. Changed entries are colored and carry a letter: amber M modified, emerald A added or U untracked, red C conflict. A folder takes the color of what changed inside it. Gitignored entries are dimmed.
4. Keyboard, following the WAI-ARIA tree pattern: Up and Down move, Home and End jump, Right expands a folder or moves into it, Left collapses a folder or moves to its parent, typing letters jumps to the next entry whose name starts with them.
5. Enter on a folder toggles it. Enter on a changed file in a worktree opens its diff below the tree, the same view the Changes list uses; Escape closes it. Enter on any other file, or Shift+Enter on any entry, adds `@path` to the composer draft without leaving the tree.
6. Right-click opens a menu: Mention in message, Show changes (changed files only), Copy path, Reveal in Finder.
7. The header has Collapse all, Reveal in Finder and Refresh. The tree updates by itself when files appear, disappear or change in an expanded folder, and when a turn ends.

## Design

Ported from Zed's project panel (`crates/project_panel/src/project_panel.rs`):

- **Taken:** a flat list of visible entries with a depth per row, rendered virtualized (`@legendapp/list`, fixed 24 px rows); per-directory lazy loading on expand; git status colors and dimmed ignored entries; folders aggregate their children's status; the keyboard model (`select_next`, `select_prev`, `expand_selected_entry` moving into an open folder, `collapse_selected_entry`, `select_parent`, open on Enter); indent guides; selection kept in view.
- **Changed:** Left on a file or collapsed folder selects the parent instead of collapsing the nearest open ancestor, which is what the ARIA tree pattern expects. Type-ahead comes from the ARIA pattern, Zed has no equivalent.
- **Dropped:** rename, new file or folder, delete, cut, copy, paste and drag and drop; multi-select; several worktree roots in one panel; auto-folding single-child folders (`auto_fold_dirs`); sticky ancestor rows; a file preview or editor.

### Data

`src/shared/domain.ts` adds `FsEntry { name, path, kind: "file" | "dir" | "symlink", ignored, gitStatus }`. `path` is relative to the root, so it is what the composer mention and git use. `ChangedFileStatus` gains `conflict`, which `worktrees.changes` now also reports for unmerged paths.

### rpc and pushes

- `fs.list {root, path} -> FsEntry[]` returns one directory level. There is no recursive listing: `files.list` already serves `@` completion.
- `fs.watch {root, paths}` replaces the set of watched directories for that root. The renderer sends the root plus every expanded folder, and an empty set when the thread view unmounts.
- Push `fs.changed {root, path}` fires 100 ms after the last change in a watched directory. The renderer re-lists that directory.

### Main: `services/Files.ts`

- **Trust boundary.** `root` must equal a project `rootPath` or the path of a worktree that is not removed. `path` must be relative, must not contain a `..` segment, and its realpath must stay inside the root's realpath, so a symlink cannot lead out. Anything else fails with `FsAccessError`. The containment check (`isInside` in `security.ts`) is shared with the attachment protocol.
- **Listing.** `readdir` with file types. Symlinks are leaves and are never followed.
- **Ignored.** One `git check-ignore --stdin -z` per listing, fed the listed folder and its entries. A folder inside an ignored folder is ignored as a whole.
- **Status.** `git status --porcelain -z --no-renames` limited to the listed folder gives untracked files, conflicts and uncommitted edits. In a worktree, `git diff --name-status` against the merge base with the base ref adds what the agent committed, so the colors agree with the Changes list. Paths are made relative to the root with `rev-parse --show-prefix`, which matters when a project root is a subfolder of its repository. Outside a git repository the listing has no status and nothing is ignored.
- **Watching.** One non-recursive `fs.watch` per watched directory, closed when it leaves the set and when the runtime shuts down.

### Renderer

- `stores/explorer.ts` (zustand), keyed by root: `expanded`, `children` per folder, `selected`. `flattenTree` turns that into the visible `{entry, depth}` rows.
- `components/FileExplorer.tsx` renders `role="tree"` with `aria-activedescendant`, and each row as `role="treeitem"` with `aria-level`, `aria-expanded`, `aria-selected`, `aria-setsize` and `aria-posinset`, so the virtualized rows still read as a tree.
- The diff pane reuses the `FilePatch` view the Changes list renders, fed by the same `worktrees.changes` atom.
- Status colors are tokens (`--vcs-modified`, `--vcs-added`) in `index.css`, shared with the Changes list, with a letter beside each so color is never the only signal.

## Out of scope

- Editing the tree: rename, create, delete, move. Agents do that; the explorer shows it.
- Opening a file's contents. kkcode is not an editor; Reveal in Finder hands off to one.
- Deleted files. They are not on disk, so they are not listed; their folder shows as modified and the Changes list has the diff.
- Following symlinked folders.
- Diffs for threads in the project root. There is no base ref to diff against, so Enter mentions the file.
- Hiding ignored files. They are dimmed, not removed.

## Verification

- `services/Files.integration.test.ts` runs against a temp git repo: sorting, kinds, `.git` hidden, ignored entries, status for modified, untracked and committed-in-worktree files, folder aggregation, and refusals for an unknown root, an absolute path, `..`, a symlink out of the root, and a removed worktree. It also checks that a watched folder pushes `fs.changed`.
- `security.test.ts` covers `isInside`.
- `stores/explorer.test.ts` covers `flattenTree`.
- `e2e/features/file-explorer.feature` lists a worktree, shows a modified and an ignored entry, and walks the tree with the keyboard.
- In the app: screenshots of the Files tab in light and dark with a modified file and an ignored folder, and a 5,000-entry folder expanded and scrolled.
