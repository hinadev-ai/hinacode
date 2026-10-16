# File editing and line comments

Status: Shipped
Date: 2026-10-13

## Problem

The file viewer is read-only. A developer who spots a typo or a wrong constant in a file the agent wrote has to open an IDE, find the worktree, fix one line, and come back. A one-line fix should not cost a window switch.

Telling the agent what is wrong in a file is worse. The developer writes "in `src/api.ts`, around the fetch in `load`, retry only on 5xx", and the agent searches for the place. The viewer already shows the line. The developer should be able to point at it.

## User flow

1. Open a file from the Files view. The viewer is an editor: click a line and type. Undo, redo, multiple cursors, find and bracket matching come from the editor.
2. After the first change the header shows a dot and Save. `mod+s` or Save writes the file. The dot goes away.
3. Switching to another file or closing the viewer keeps the unsaved edits in memory. The tree marks the file with a dot, and opening it again shows the edits. Quitting the app drops them, like composer drafts.
4. When the agent changes a file with unsaved edits, the viewer keeps the edits and says the file changed on disk, with Overwrite and Reload. Overwrite saves the edits over the agent's change. Reload drops the edits and shows the file on disk. Saving after the agent's change, before the notice arrives, fails with the same notice instead of overwriting.
5. Hovering a line shows a + in the gutter. Clicking it, or dragging it over several lines, opens a comment box under the last line. From the keyboard, select lines in the editor and press `mod+alt+c`. Type the comment, then press `mod+Enter` or Add comment. Escape or Cancel drops it. Either way, focus goes back to the editor.
6. The comment stays under its line, with Edit and Delete. The composer lists every comment as a chip, such as `src/api.ts:12-14`, with a remove button.
7. Send or Steer delivers the typed text, then every comment with its path and lines, the commented code, and the comment. The comments leave the draft with the text. A failed send puts them back.

## Design

### Data

```ts
// stores/drafts.ts
interface LineComment {
  readonly id: string
  /** Relative to the thread's working directory. */
  readonly path: string
  /** 1-based and inclusive. */
  readonly startLine: number
  readonly endLine: number
  /** The commented lines as the user saw them, so the agent finds them even after the file moved on. */
  readonly code: string
  readonly body: string
}
interface Draft { text; attachments; worktree; comments: ReadonlyArray<LineComment> }

// stores/explorer.ts, per root
interface ExplorerTree { …; unsaved: Readonly<Record<string, string>> }  // path -> text the edits started from
```

- Comments belong to the draft, not the file. They are context for the next message, so they live, send, fail and restore with the text. Kept in memory like the rest of the draft.
- `unsaved` holds a path only while it has unsaved edits. Its value is the text the edits started from. That is the `expected` text of the save, and it decides whether the disk moved on.
- The edits themselves stay in the editor library. `@pierre/diffs` keeps them in its `EditStateManager`, keyed by root and path, and hinacode does not keep a second copy.

### rpc

`fs.write {root, path, content, expected}` replaces the text of an existing file under a known root, with the same checks as `fs.read`: a known root, a relative path without `..`, and a realpath inside the root. It never creates a file. When `expected` is a string and the file no longer holds it, the write fails with `FsWriteConflict` and leaves the file alone. `expected: null` overwrites, which is what Overwrite sends.

### Editor

`FileViewer` renders the same `File` component of `@pierre/diffs` with `edit` on, under an `EditProvider`. The library already ships the editor, so no second highlighter or editor framework enters the bundle. Truncated and binary files stay read-only.

- The `file` given to the component is the `unsaved` base while the file has edits, else the text on disk. The library replaces the document when its `file` changes, so this keeps an `fs.changed` reload from wiping the edits. The viewer compares the disk text with the base to show the changed-on-disk notice.
- `onEditChange` compares the document with the base and sets or clears the path in `unsaved`.
- Save calls `fs.write` with `expected` set to the base. On success it clears `unsaved` and reloads, so the base becomes the saved text.
- Reload clears `unsaved`. The base becomes the disk text, the `file` changes, and the library replaces the document.

### Comments

The viewer passes `enableGutterUtility` and `onGutterUtilityClick`, which give the + and a dragged line range. One state, `CommentForm`, holds the open box: a new comment on a range, or an edit of one comment, so two boxes cannot be open at once. Comments for the open path and a new-comment box render as `lineAnnotations` through `renderAnnotation`, and the range is highlighted only while its box is open. The box takes focus once it has a size, because the library lays annotations out after React mounts them.

`promptWithComments(text, comments)` in `lib/lineComments.ts` builds what is sent. The typed text comes first, then one block per comment with `path:start-end`, the code, and the comment. The code sits in a fence longer than any backtick run inside it. `fenceFor` moved to `src/shared/fence.ts` so the element picker and this share it. The transcript shows that text, so the developer sees exactly what the agent read.

## Out of scope

- Creating, renaming and deleting files. Agents do that, and the explorer shows it.
- Comments in the Changes diff. The diff view can reuse `LineComment` and the annotation renderer later.
- Persisting unsaved edits or comments across restarts. Composer drafts do not persist either.
- Moving a comment when the file changes under it. The comment quotes its code, so the agent can find it.
- Rebindable save and comment shortcuts. `mod+s` and `mod+alt+c` only act inside the viewer, where `mod+s` is the convention everywhere.
- A name for the gutter +. The library adds that button to a line only on hover, and the keyboard path is `mod+alt+c`.
- Language servers, formatting, completion. The IDE does those.

## Verification

- `services/Files.integration.test.ts` covers `fs.write`: replace, matching and stale `expected`, `null`, and refusals for an unknown root, an absolute path, `..`, a symlink out of the root, a folder, and a missing file that must not be created. `ipc.integration.test.ts` refuses `fs.write` outside a known root.
- `stores/drafts.test.ts` covers comments taken and restored with the draft. `lib/lineComments.test.ts` covers the prompt, including a backtick run in the code.
- In the app, verified in light and dark: edit and save with `mod+s` and with Save, then check the disk. Edit, switch files and come back. Edit, change the file from a shell, then Overwrite, and again with Reload. Comment a dragged range and a line with `mod+alt+c`, edit one, remove one from the composer, send, and read the transcript.
