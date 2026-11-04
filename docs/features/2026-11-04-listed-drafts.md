# Listed unsent threads

Status: Building
Date: 2026-11-04

## Problem

A new thread stays out of the sidebar until its first message. If the developer writes half a prompt and opens another thread, nothing in the list shows that the text exists, and a restart loses it. Text left in an existing thread is just as invisible. Changing the model or access mode while writing counts as activity, so the thread jumps to the top of the Inbox and wakes from a snooze.

## User flow

1. The developer starts a new thread and types. Once the composer holds text, an attachment or a line comment, the thread appears as unsent, titled by the first line of its text.
2. In the Inbox it sits under **Drafts**, at the very top. Under Threads it sits at the end of its project.
3. Writing in an existing thread leaves its row in place. The row shows **Draft** where it shows its age.
4. Clearing the composer removes the mark or the row. **Discard** on an unsent row empties it, and the toast offers Undo.
5. Unsent text survives a restart. Sending moves a new thread into the list as a normal thread, which counts as activity.

## Design

- `useDrafts` persists to `localStorage` under `hinacode.drafts`, like `useUnseen`. Text stays in the renderer and needs no rpc on each keystroke. Only the main window writes it, because a pull request window holds its own stale copy of the map. `thread.removed` deletes a thread's draft and its side chat's.
- Chromium writes `localStorage` to disk lazily, so a crash can lose the last few seconds of typing. A normal quit keeps it.
- `hasContent` in `stores/drafts.ts` decides what counts. A picked workspace alone does not.
- The sidebar joins `useThreads.drafts` with `useDrafts`. Row positions never read composer content, so writing cannot reorder them.
- `Threads.write` treats provider, account, model, effort, fast mode, skills and access mode as arranging, like sorting, pinning and snoozing. They keep `updatedAt` and the snooze.
- A project still has one draft thread. Starting a new thread there reopens it with its text.

## Out of scope

- Several new drafts per project. `threads.draft` reuses one, and that is enough until it is not.
- Syncing drafts between devices. They belong to one renderer's `localStorage`.
- The mobile app's lists.

## Verification

- `ipc.integration.test.ts` covers composer settings keeping `updatedAt` and the snooze. `drafts.test.ts` covers `hasContent`.
- `threads.feature` covers a listed draft across a restart, discarding it, and writing without moving a row.
- With `verify-hinacode`, type in a new thread and an existing one, and screenshot the Inbox and Threads tabs.
