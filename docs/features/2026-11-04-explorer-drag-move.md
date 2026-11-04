# Drag to move in the file explorer

Status: Shipped
Date: 2026-11-04

## Problem

The Files panel can rename an entry but not move it to another folder. A name cannot contain `/`, so moving a file meant leaving HinaCode for a terminal or another editor.

## User flow

1. Drag a file or folder by its row. The row and everything under it dims.
2. The folder that would receive it lights up, along with the rows inside it. Hovering a file targets the folder that holds it, and hovering the empty space or a top-level file targets the root.
3. Holding over a collapsed folder for 600 ms opens it, so a drag can reach a folder several levels down.
4. Releasing moves the entry, opens the target folder, selects the moved row and shows a toast with Undo. An open file stays open under its new path.
5. Escape, or releasing outside the tree, cancels. The cursor shows not-allowed over the entry's current folder and over the entry itself or anything inside it.
6. A name the target already uses is refused with a toast, and nothing is overwritten. An entry holding unsaved edits is refused with a toast asking to save first.

## Design

The move is `fs.rename` with a `to` in another folder, which already validates both paths and refuses an existing target. The main process needs no new code.

The store lists the target folder before moving, so a name clash gets the same message as the rename field, including for a collapsed folder that was never loaded. `fs.rename` stays the authority if the folder changes in between, but the renderer shows every `FsAccessError` as a generic "could not read" message.

The renderer holds one value, `{ source, over } | null`, so a drop target cannot exist without a dragged entry. `dropFolderOf` turns a hovered row into its target folder, and `canMoveInto` refuses a no-op or a move into the entry's own subtree. Spring opening is an effect keyed on the hovered collapsed folder, so changing target or ending the drag cancels its timer.

Native HTML drag and drop instead of `@dnd-kit`, which the sidebar uses. Rows are virtualized, so a droppable per row would come and go as the list scrolls. Native events hit whichever row is under the pointer, Chromium scrolls the list near its edges and handles Escape, and the OS draws the drag image. The payload uses a private MIME type, so the composer's file drop and text fields ignore it.

The toast opens at the bottom right, because the app's usual top right corner covers the first rows of the tree and would block the next drag.

Rows being renamed are not draggable, because a draggable ancestor stops the mouse from selecting text in the input.

Unsaved edits are refused rather than dropped. `afterRename` forgets them because the editor keys its buffer by path. That is acceptable for a deliberate rename, but a drag is easy to start by accident. Undo goes through the same check.

## Out of scope

- Moving from the keyboard. The tree has no cut and paste yet, which would be the natural way in.
- Dragging several entries, copying with a modifier, and dropping files from the OS into the tree.
- Dropping a row on the composer to mention it.

## Verification

- `services/Files.integration.test.ts` moves a file and a folder across folders, and refuses a move into the folder's own subtree or onto an existing name.
- `stores/explorer.test.ts` covers the target folder for each row kind, the refused moves, and the paths after a move.
- `e2e/features/file-explorer.feature` drags with real mouse input, through a spring-opened folder, and undoes the move.
