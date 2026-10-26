# Snooze threads

Status: Shipped
Date: 2026-10-26

## Problem

The Inbox puts every active thread in one list, newest first. A thread that is waiting on something outside HinaCode, such as a review on Monday or a deploy tomorrow morning, stays in that list and pushes the threads that need attention now further down. Archiving it hides it until the user remembers to look, and pinning does the opposite of what they want.

## User flow

1. From a row's menu, **Snooze…** opens the snooze picker for that thread. ⌘⇧S opens it for the open thread.
2. The picker is a field above a list of presets: **In 1 hour**, **This evening** (18:00, offered until 17:00), **Tomorrow** (9:00) and **Next week** (Monday 9:00). Each shows the time it resolves to. ↑ and ↓ move through them and Enter snoozes.
3. Typing a time, such as `monday 8:00`, `tomorrow 14:30`, `in 2 hours`, `月曜 8:00` or `星期一 8:00`, puts the parsed time at the top of the list, highlighted, so typing and Enter is the whole custom path. A date without a time means 9:00. Text that does not read as a time, or a time that has passed, says so and keeps the presets.
4. The thread leaves the Inbox and is listed under **Snoozed** at the bottom of the Inbox, soonest first, with its wake time where the row shows its last activity. Other lists keep the row in place and show the same wake time.
5. At the wake time the thread returns to the top of the Inbox, as if it had just been updated.
6. If the agent does something before then, such as finishing a turn or asking for approval, the thread wakes early. A snooze never hides a thread that needs the user.
7. **Unsnooze** in the row's menu wakes it now.

## Design

- `thread.snoozed_until` (migration 0024), exposed as `Thread.snoozedUntil: Timestamp | null`. A time in the future means snoozed. A past time means the thread woke then. It decodes to null when a cloud running an older version leaves it out.
- `threads.update` takes `snoozedUntil: Timestamp | null`. Like pinning, snoozing only arranges the sidebar, so it keeps `updatedAt`. Any write that does bump `updatedAt` clears the snooze, which is how activity wakes a thread. No timer runs in the main process.
- The renderer decides what is snoozed from `useNow`, which ticks every 30 seconds. The Inbox sorts by the later of `updatedAt` and a past `snoozedUntil`, which moves a woken thread to the top.
- The presets and the parser live in `src/renderer/lib/snooze.ts` and take the current time as an argument. Parsing uses `chrono-node` in the app's locale, then in English, since people type English times whatever the UI language.
- The picker is one `SnoozeDialog`, mounted by the sidebar and opened through `useUi.snoozeThreadId`, so the menu item and the `thread.snooze` command share it. Its list is a Base UI `Autocomplete`, like the command palette.

## Out of scope

- Snoozing from the mobile app. It reads `snoozedUntil` but has no picker yet.
- Recurring snoozes and per-user default times. The presets are fixed until someone asks.
- A notification at the wake time. The thread moving to the top of the Inbox is the signal, and the existing notifications already cover agent activity.

## Verification

- `ipc.integration.test.ts` covers that snoozing keeps `updatedAt` and that activity clears the snooze.
- `snooze.test.ts` covers the presets and the parser against fixed times. `threads.test.ts` covers the Inbox and Snoozed selectors.
- With `verify-hinacode`, open the picker from a row's menu and with ⌘⇧S, type `monday 8:00`, press Enter, and screenshot the Snoozed section.
