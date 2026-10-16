# Queued messages

Status: Shipped
Date: 2026-10-16

## Problem

While an agent works, every message the developer sends steers the running turn. Often the developer only wants to line up the next task ("then write the tests", "then open the PR") without derailing the work in progress. Today they have to watch the thread and wait for it to finish before typing, which is the attention cost hinacode exists to remove.

## User flow

- While the agent runs, Enter queues the draft. The send button reads Queue.
- Mod+Enter steers the running turn instead, the old behavior. A Steer button next to Queue does the same with the pointer.
- Queued messages show above the composer, oldest first. Each row has Steer now, Edit and Remove.
  - Steer now sends it into the running turn, or starts a turn when the thread is idle.
  - Edit takes it out of the queue and puts it back in the composer.
- When a turn completes, the oldest queued message starts the next turn. The thread keeps going until the queue is empty. The "completed" notification is skipped while the queue still holds messages.
- A turn that fails, is stopped, or hits a usage limit leaves the queue alone. The developer decides what to send next. The next turn that completes picks the queue up again.
- When the thread is idle, Enter sends as before.

## Design

- `Thread.queue` is an array of `QueuedMessage { id, text, attachments }`, oldest first, stored as JSON in the `thread.queue` column (migration 16). Living on the thread means the existing `thread.updated` push carries it to the window, the sidebar and remote clients, and it survives a restart.
- `threads.queue` appends to the queue while the thread is busy, and sends like `threads.send` when it is not. `threads.unqueue` removes one message and returns it, or null when it already left. Steer now and Edit use the returned message, so a message the runner already sent is never sent or restored twice.
- `AgentRunner` decides under the thread's lock. Queueing checks `busyThreads` and appends. A turn's `finish` takes the oldest message when the turn completed and nobody stopped it, and keeps the thread claimed in `busyThreads` so no other send slips in. The next turn then starts outside the lock. If it cannot start, the message goes back to the front of the queue.
- Other steer callers keep steering: question answers, `send_to_thread`, the pull request panel and the pull request watcher.

## Out of scope

- Reordering queued messages. Edit and re-queue covers the rare case.
- Merging several queued messages into one turn. Each one stays its own turn, as the developer wrote it.

## Verification

`AgentRunner.integration.test.ts` covers queueing during a turn, draining after completion, keeping the queue after an interrupt, and `unqueue`. In the real app with `verify-hinacode`: queue two messages during a turn and watch them run in order, steer with Mod+Enter, and edit a queued message back into the composer, in light and dark.
