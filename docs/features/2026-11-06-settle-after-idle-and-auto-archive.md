# Settle quiet threads and archive settled ones after a set number of days

Status: Shipped
Date: 2026-11-06

## Problem

A thread without a pull request never settles by itself. The renderer showed a read thread under Settled after 7 quiet days, but that was only a view: `settled_at` stayed empty, its dev servers and agent session kept running, and nothing ever archived it. A developer with hundreds of threads cleaned them up by hand.

## User flow

1. In Settings, Finished threads, the developer enters a number of days, 1 to 365, for **Settle a quiet thread after** (default 7) and **Archive a settled thread after** (default never). An empty field means never.
2. A thread that has been idle that long, has no open or draft pull request, and has nothing running settles, and its processes stop, as a manual settle does.
3. A thread that has stayed settled for the second number of days is archived. Archiving closes its terminals and removes its scratch folder, and its worktree when **Remove the worktree when archiving** is on.
4. Pinning a thread keeps it out of both. Any new activity or Reopen restarts the count.

## Design

- `ArchiveSettings` gains `settleAfterIdleDays` and `archiveAfterSettledDays`, each a whole number of days or `null` for never. Saved settings decode with the defaults, 7 and `null`.
- The existing `Settle` sweep runs every 3 minutes and adds two passes after the merge pass. Idle counts from `updatedAt`, or from `snoozedUntil` while that is later. Settled time counts from `settledAt`.
- The idle pass applies the same "quiet" test as the merge pass: no background task, running sub-agent or listening port. It reads pull requests only for threads that are already idle long enough, then re-reads the thread and settles it only if `updatedAt` has not moved.
- The archive pass skips a thread whose worktree has uncommitted changes when worktree removal is on, because no one is there to see the changes go. It releases the thread first, so nothing is left writing to the worktree, then `Threads.archiveIf` rechecks inside the worktree lock that the thread is still settled long enough, not pinned, and clean under the current setting. A pin, a reopen or a settings change during the sweep therefore wins.
- The 7-day view in `inboxGroup` is gone. The main process now settles those threads for real, so the setting decides and the renderer has one source of truth.
- The main process does not know which threads were read, so an unread thread settles after the idle period too. A week of silence is long enough that this is the desired outcome.

## Out of scope

- Archive keeps the thread's attachments. They are part of the transcript, and Unarchive should restore it whole. Delete is the step that should remove them.

## Verification

- `Settle.integration.test.ts`: an idle thread settles on the configured day and not before; one with an open pull request does not; a settled thread archives on its day; a dirty worktree keeps a settled thread out of auto archive until it is clean, then the worktree is removed.
- With `verify-hinacode`, open Settings, Finished threads, and pick values for both selects.
