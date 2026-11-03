# Scheduled messages

Status: Building
Date: 2026-11-03

## Problem

A developer often knows the next prompt before they can send it. The usage limit resets at 23:00, or they are leaving for the night and want an agent to start a long task at 2:00 when nobody else is on the machine. Today they have to stay awake, set an alarm, or leave a sticky note. The queue only helps while a turn is running, and resume-at-reset only resends the last prompt.

## User flow

1. The developer writes a message in a thread's composer, with attachments or line comments if they like.
2. They click the clock button next to send. A time picker opens with presets (in 1 hour, this evening, tomorrow, next week, and "when the limit resets" on a limited thread). They can type a time instead, such as `tonight 23:00` or `in 2 hours`, in any of the app's languages.
3. They press Enter or click a choice. The composer clears and the message appears in the tray above the composer with the time it will send.
4. Each row has three actions. Change time opens the same picker. Edit moves the message back into the composer and drops the schedule. Cancel deletes it.
5. At the chosen time, the message sends exactly as if they had pressed Enter then. If the thread is idle it starts a turn. If a turn is running or waiting on an approval, it joins the queue and starts when the turn ends.
6. If the send fails, for example because the thread's worktree folder is gone, the row stays in the tray and says why. The developer can change the time to try again, edit it, or cancel it.

Keyboard path: the clock button is in the composer toolbar's tab order. The picker takes focus, arrow keys move through the choices, Enter picks, Escape closes.

## Design

**Data.** Scheduled messages live on the thread, next to the queue, in a new `thread.scheduled` JSON column (migration `0036_thread_scheduled`). Each entry is a `ScheduledMessage`:

```ts
{ id, text, attachments, workspace?, sendAt, failure? }
```

`workspace` carries the workspace choice of a thread that has not started yet, so the first message of a new thread can be scheduled too. `failure` is set when delivery failed, and a failed entry is never retried on its own. Keeping the list on the thread row means it is deleted with the thread, and every `thread.updated` event already carries it to the renderer, so no new event or store is needed.

**Timer.** `AgentRunner` already checks once a second whether a limited thread's reset has passed. The same loop now also sends due scheduled messages. For each thread with a due entry, it claims the earliest one in memory, so overlapping checks cannot send it twice and Edit or Cancel leave it alone while it is on its way. The entry stays stored until it has left. If a turn is running, it moves into the queue in the same row update. Otherwise it goes through `send`, and the entry is removed once the turn has started, so quitting while a worktree prepares keeps it for the next launch. An entry with a `workspace` uses it only while the thread has no worktree and no messages. An archived thread is unarchived first, as `threads.send` does when the developer types into one. On failure, the entry stays in place with `failure` set.

One entry per thread per tick keeps the order. When two entries are due at once, the first starts a turn, and a second later the next one sees a busy thread and joins the queue behind it.

**Missed while closed.** A schedule that came due while the app was closed sends on the first tick after launch, however late it is. The developer asked for the message to go out and did not cancel it, and the row in the tray made the pending send visible before they quit. Several overdue entries in one thread go out in `sendAt` order, through the queue.

**Rpc.** `threads.schedule` adds an entry, `threads.reschedule` moves one to a new time and clears its failure, and `threads.unschedule` removes one and returns it, which both Cancel and Edit use. All three run under the same per-thread lock as `queue` and `unqueue`.

**UI.** The composer gains a clock button and the tray gains a `ScheduledBar` beside the `QueueBar`. The time picker is the snooze picker's autocomplete, pulled out into a `TimePicker` that both dialogs share, so typed times use the same chrono parser in every locale.

## Out of scope

- Recurring schedules. Automations already run prompts on a trigger.
- Scheduling from a side chat. Side chats are short and live inside their parent thread.
- Sending while HinaCode is closed. The main process owns the timer, so a closed app sends on next launch. Waking the machine or running a background daemon would add a moving part for a rare case.

## Verification

- `src/main/services/AgentRunner.integration.test.ts` runs against a real SQLite database. It covers an overdue entry starting a turn while a later one waits, a due entry joining the queue of a busy thread, and a failed send staying on the list with its reason until it is rescheduled or cancelled.
- `Thread.scheduled` decodes to an empty list when a server predates the column, which the mobile client's connection tests exercise.
- In the real app with `verify-hinacode` and the mock agent: schedule a message two minutes out, see it in the tray, quit before it is due, relaunch after, watch it send, and screenshot each state into `.context/`.
