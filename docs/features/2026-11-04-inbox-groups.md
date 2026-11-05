# Inbox groups

Status: Building
Date: 2026-11-04

## Problem

The Inbox was a recency list of every active thread. A new turn in any thread pushed down a thread that had waited on the developer for twenty minutes, nothing left the list unless it was archived by hand, and the list could not be empty.

## User flow

`Draft → Working ⇄ Ready → Settled → Archived → Deleted`, with Snoozed as a side step from Ready.

Internal statuses stay `draft`, `running`, `idle` and `archived`, plus `thread.settled_at`. `specs/ThreadLifecycle.tla` checks every transition, and `docs/arch.md` draws them.

1. **Drafts** come first. See `2026-11-04-listed-drafts.md`.
2. **Ready** holds questions, usage limits, failures, finished turns, pull request problems and read threads, newest activity first. Read threads recede, so what needs the developer stands out without moving. The Inbox tab's badge counts only what has not been read and has not settled.
3. **Working** holds agents running and background work. Its heading folds it, and the choice persists. The pulse button in its heading swaps each row's third line for the agent's latest tool call.
4. **Settled** stays at the bottom of the sidebar, outside the scrolling list, and opens upward with its own scroll. It renders 50 rows and adds 50 more as the scroll nears the end, so opening stays fast with thousands of threads. Settling from a row or the row menu moves a thread there, with Undo. A settled thread keeps its workspace, terminals and scratch folder. **Reopen** or a new message brings it back.
5. A thread settles by itself when its own pull request merges and no work started after the merge. A pinned thread does not. A pull request closed without merging stays in Ready for the developer to decide. If **Remove the worktree when archiving** is on, the merge sweep removes the merged worktree too.
6. A read thread with no open pull request and no activity for 7 days shows under Settled, without changing its row or touching its worktree. Any activity or Reopen brings it back.
7. **Archived** sits below Settled. Archiving closes the workspace: terminals, chat folder and scratch folder, and the worktree when the setting is on.
8. Reopening is sticky. It stamps `work_started_at` and bumps `updated_at`, so neither an old merge nor the quiet rule settles the thread again until something new happens.

## Design

- `inboxGroup` in `shared/threadStatus.ts` computes the group from `rowState` and `settledAt`. A settled thread that starts work leaves Settled because `Threads.write` clears `settled_at` whenever `startsWork` is true.
- `thread.settled_at` (migration 0042) is separate from `archived` because settling is cheap and reversible and archiving releases resources.
- `Archive when merged` is now on by default. Worktree removal stays a separate setting, off by default.
- `thread.work_started_at` (migration 0041) is stamped when a thread goes from idle to running and when it is unarchived. `AutoArchive` wraps up only for a merge later than it, using `mergedAt` from `gh`. A turn that merges its own pull request still settles, and a reopened thread does not settle again for an old merge.
- `Archive when merged` now settles. Its key stays `archive.whenMerged`, so saved settings keep working.
- A settled thread does not hold a shared worktree, so a fork can still clean it up.
- The 7-day rule stays in the renderer because the main process doesn't know what has been read, and because a timer must not remove a worktree that holds unmerged work.
- `useActivity` keeps each thread's latest tool call from `message.created` and `message.updated` pushes, so a thread that was never opened still has a line.

- Inbox rows have three lines. The first holds the project, with its favicon or first letter, and the age. The second gives the title the whole line, except for a status icon at the end. The third says what is happening on the left and who runs it on the right: the provider, and the cloud's icon and truncated name for a thread that runs on a cloud. A thread on this machine shows neither.
- The third line's left side reads, in order: what a blocked agent asks, when a usage limit resets, why a turn failed, the latest tool call when the pulse button is on, and a pull request problem in words. With none of those it shows the pull request, or the branch when there is none. `useActivity` keeps this line from `thread.event` pushes, so it works for threads that were never opened. It holds nothing after a reload, and the row falls back to a status word.
- Brightness carries attention. A title that needs the developer reads at `--sidebar-title`, a read one at `--sidebar-meta`, and a hovered or open row steps up to full strength. In Hina Dark these tokens sit lower than the palette's foreground, so a resting list stays quiet. Every line clears 4.5:1 on its row's background, except the dimmed **Working** rows, which stay at 60% opacity until hovered.
- Only finished and usage-limited threads keep a color. Every other icon uses the foreground or a muted tone, and ages drop "ago".
- Text starts on one left edge and ends on one right edge, from the title bar down. Counts in headings share the right edge with ages.
- **Drafts**, **Ready** and **Working** are one list, so a row glides between them when the turn passes. A row that arrives or leaves opens or closes its space instead, and only a change of order or section glides. A thread the composer is sending counts as Working until its status says it started, so a sent draft never passes through Ready. Their headings stay pinned while the list scrolls, and **Working** also pins to the bottom edge while its rows are below the fold.

## Out of scope

- The mobile app's tabs and its Archive wording.
- A board of all agents in the main area. Add it if one line per agent is not enough.
- A separate group for pull requests waiting on a reviewer. They stay in Ready, dimmed, and snoozing moves one out.

## Verification

- `threadStatus.inbox.test.ts` covers grouping and order. `AutoArchive.integration.test.ts` covers merged, closed, reopened and merged-during-a-turn threads.
- `threads.feature` covers settling, archiving, Undo and Reopen.
- With `verify-hinacode`, seed threads in each state with `HINACODE_MOCK_CLAUDE`, and screenshot the Inbox in both themes.
