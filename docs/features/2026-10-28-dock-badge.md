# Dock badge

Status: Shipped
Date: 2026-10-28

## Problem

A developer running many threads works in another app while agents finish. The desktop notification fires once and is gone. Nothing outside the HinaCode window says how many threads are still waiting on them, so they switch back to check.

## User flow

1. A thread finishes or fails a turn the developer has not opened, waits for approval or an answer, hits a usage limit, or has a pull request that conflicts, fails checks or has changes requested.
2. The HinaCode Dock icon shows how many threads are in that state, like Mail or Slack.
3. Opening the thread, answering it, or snoozing it lowers the count. At zero the badge disappears.

## Design

- The count is the sidebar's own definition. A thread counts when `rowEmphasis[rowState(...)]` is `"attention"`, exposed as `needsAttention` in `src/shared/threadStatus.ts`. A new row state that needs the user counts on the Dock with no extra change.
- Only awake threads count (`selectAwakeThreads`): active, not snoozed, pinned or not. Snoozing means "not now", so the badge respects it.
- The renderer owns the count, because unseen marks (`useUnseen`, localStorage) and pull request status (`pullRequestAttentionAtom`) already live there. `DockBadge`, mounted once in `App`, computes it and sends `app.setBadgeCount` whenever it changes.
- `app.setBadgeCount` is a desktop-only rpc that calls Electron's `app.setBadgeCount`. The schema accepts only non-negative integers.

## Out of scope

- The Windows taskbar overlay. `app.setBadgeCount` does nothing there.
- Linux. Electron sets the count on Unity launchers only, so most desktops show nothing.
- A setting to turn the badge off. Add it when someone asks.

## Verification

- `threads.test.ts` covers which threads are awake.
- With an isolated instance launched with `--inspect`, read `require('electron').app.getBadgeCount()` from the main process, and the Dock tile's `AXStatusLabel` through System Events. Two unseen threads read 2. Opening one reads 1. Snoozing the other reads 0 and clears the tile. Undo reads 1 again.
