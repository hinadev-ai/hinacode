# Inbox, pinned threads and the new thread picker

Status: Shipped
Date: 2026-10-14

## Problem

The sidebar groups threads by project, in an order the user drags by hand. With agents running in several projects, the thread that just finished or just asked for something can be anywhere in that tree, so finding it means scanning every group. A few threads the user keeps returning to have no fixed place. And ⌘N always starts a thread in the open thread's project, so starting one in another project means leaving the keyboard for the sidebar.

## User flow

1. The **Inbox** tab lists every active thread from every project in one list, most recently updated first. A thread that is created, starts a turn, finishes or waits for approval moves to the top. Each row names its project. The sidebar reopens on the last tab picked.
2. **Threads** and **Archived** are unchanged.
3. From a row's menu, **Pin** moves the thread into a Pinned list above the tabs, in the order it was pinned. **Unpin** puts it back. A pinned thread is not repeated in the tabs below, except under Archived when it is archived.
4. ⌘N opens the palette on a project picker. The open thread's project comes first, so ⌘N Enter keeps the old behavior. Typing filters the projects. ⌘1 to ⌘9 start a thread in a project by its place in the project list, and Backspace over the `+` returns to quick open. The home page's New thread button opens the same picker.

## Design

- `thread.pinned_at` (migration 0014), exposed as `Thread.pinnedAt: Timestamp | null`. Null is unpinned. The time orders the Pinned list, so it does not need its own sort index.
- `threads.update` takes `pinned: boolean`, and the server stamps the time. Pinning, like reordering, does not bump `updatedAt`, so it does not move the thread in the Inbox.
- The renderer reads the Inbox from the thread store sorted by `updatedAt`. No new rpc.
- The picker is a palette mode with the `+` prefix, whose source lists projects with a fixed `Mod+<n>` chord each. The palette runs an item when its chord is pressed.

## Out of scope

- Reordering pinned threads by drag. Pin order is enough until it is not.
- A "No project" thread. Every hinacode thread runs in a project.

## Verification

- `ipc.integration.test.ts` covers pinning through rpc and that it keeps `updatedAt`.
- `threads.test.ts` covers the Inbox and Pinned selectors.
- `threads.feature` covers the Inbox order, pinning and both across a restart. `command-palette.feature` covers the picker's order, Enter and `Mod+1`.
- With `verify-hinacode`, create threads in two projects, pin one, and screenshot the sidebar. Press ⌘N and screenshot the picker.
