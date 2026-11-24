# Continue interrupted turns

Status: Shipped
Date: 2026-11-23

## Problem

When HinaCode quits, crashes, or `hinacode serve` restarts in the middle of a turn, the thread used to come back idle. Nothing said the agent was cut off, so a developer with many threads found out only by reading each transcript, and then had to type a prompt to pick the work up again.

## User flow

A thread that was running or waiting on an approval when HinaCode stopped comes back as Interrupted. Its sidebar row shows a stop mark in the attention color, the Inbox counts it, and the thread view shows "HinaCode stopped before this turn finished" above the composer with a Continue button. Continue sends one short prompt on the thread's provider session, so the agent resumes with its context. Typing a message works too. Either one starts a turn, and the marker goes away. A side chat cut the same way shows the callout above its own composer.

From a terminal, `hinacode inbox` lists the thread as an `interrupted` ask, `hinacode ls --status interrupted` finds them all, and `hinacode continue <ref>` resumes one.

## Design

`ThreadStatus` gains `interrupted`, next to `limited`. Migration 53 widens the status check in place, the way migration 33 added `draft`. A status rather than a flag means a new turn clears it with no extra write, and a thread can't be interrupted and running at once.

Two paths set it:

- A graceful quit (window close, app quit, daemon SIGTERM) disposes the runtime, which interrupts each turn fiber. `makeTurn` records the interruption, and `finish` writes `interrupted` instead of `idle` unless the developer had pressed Stop.
- A crash or SIGKILL leaves the row `running` or `awaiting_approval`. At startup `Threads.resetInterrupted` turns those into `interrupted` and clears their snooze, the same as any other status change. `Messages.closeInterrupted` already closed their open messages, and now also covers `interrupted` rows whose tool calls a quit left running.

`threads.continue { threadId }` calls `AgentRunner.continueInterrupted`. It does nothing while the thread is busy, and otherwise sends `CONTINUE_PROMPT` with `sendWhen`, whose guard checks for `interrupted` under the thread lock. A double click, two CLI calls, or a second restart start at most one turn. The route table sends the call to the machine that owns the thread, so it works for threads on a paired `hinacode serve`.

The pull request watcher holds wakes for an interrupted thread as it does for a limited one, so a CI update does not resume work on its own. Settling an interrupted thread by hand puts it on the same auto-archive clock as an idle one.

## Out of scope

- Resuming on its own after a restart. Auto-run surprised people elsewhere when a session they had finished came back to life, so Continue stays a click. A "Resume interrupted work on restart" setting can come later.
- Continue on the phone. The phone shows the Interrupted status, and sending a message there resumes the thread.

## Verification

- `Threads.integration.test.ts` checks that startup marks only busy rows and is idempotent across restarts. `AgentRunner.integration.test.ts` checks that disposing the runner mid-turn leaves the thread `interrupted`, that two concurrent Continues and a third one start one turn on the saved session, and that Continue on an idle thread does nothing. `threadInterrupted.integration.test.ts` covers the migration, and `asks.test.ts` the CLI inbox.
- With `verify-hinacode` and `HINACODE_MOCK_CLAUDE=stop`, send a message, then kill the instance with `stop.sh` (the crash path) or close the window with `ab eval 'window.close()'` (the graceful path). Relaunch with `--no-build`. The row shows the stop mark, the thread shows the callout, and Continue starts one turn.
