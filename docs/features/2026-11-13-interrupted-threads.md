# Interrupted threads

Status: Building
Date: 2026-11-13

## Problem

When HinaCode stops in the middle of a turn, the thread comes back `idle`. It looks finished, and nothing says the agent stopped halfway through its work.

On 2026-11-10, 24 parallel threads used up the memory of a 15 GB VM. systemd OOM-killed `hinacode-cloud.service`, and after the restart all 24 sat idle with half-finished worktrees. Someone had to open each thread to find out which ones had died (#809).

Two paths lead there today:

- A hard kill (OOM, `SIGKILL`, a crash) leaves `running` or `awaiting_approval` in SQLite. At startup, `Threads.resetInterrupted` turns them `idle`.
- A graceful stop (`SIGTERM` from `systemctl restart`, quitting the desktop app) disposes the runtime. That interrupts each turn fiber, and the turn's `finish` writes `idle`.

## User flow

1. HinaCode restarts while a thread is running.
2. The sidebar row shows an amber restart icon with the detail "Stopped by a restart". The row needs attention, like a limited thread.
3. The thread view shows a callout: "Interrupted by a restart". It says the work may be half done, and has a Resume button. The button is a normal button, so Tab and Enter reach it.
4. Resume sends one continuation prompt. The thread runs again, and the prompt shows in the transcript as a user message: the agent first checks `git status` and `git log` in its workspace, then carries on.
5. Typing any message instead also resumes the thread. Archive, snooze, pin and settle work as they do on an idle thread.

The phone shows the same label and callout.

Nothing resumes by itself. After the 24-thread crash, the developer gets 24 amber rows, and each one runs again only when they click Resume.

## Design

The thread row gains a nullable `interrupted_at`, and the status stays `idle`. A new status would break every client that decodes `ThreadStatus` from before this change: the phone's `gather`, an older peer in `remote/peers.ts`, an older npm CLI, and an older app that reads `Threads.findAll` after a downgrade. Each of them reads an extra key as nothing and keeps working, and each new client reads a missing key as `null`.

`isInterrupted` in `domain.ts` is the one rule: the status is `idle` and `interrupted_at` is set. An archived thread keeps the timestamp until it is unarchived, and is not interrupted while archived.

- **Migration 49** adds the column. Existing rows read `null`.
- **`Threads.write`** clears `interrupted_at` whenever the status turns busy, so any send, a resume, a scheduled message or a routine clears it. `unarchive` clears it too.
- **`Threads.resetInterrupted`** writes `idle`, sets `interrupted_at`, and clears a snooze, as any status write through `Threads.write` does. A thread snoozed while it ran comes back in Ready.
- **`AgentRunner` turn finish** sets `interrupted_at` when the turn fiber ended by interruption and the developer did not press Stop. A Stop ends the provider stream normally, so it writes `idle` without the mark.
- **`threads.resume`** is a new rpc. `AgentRunner.resume` refuses unless the thread is interrupted, then sends the continuation prompt through the normal `send` path. The prompt is agent-facing, so it stays in English in the main process, and the desktop and the phone share it.
- **Queued messages** stay queued. They start after the resumed turn ends, as #885 left them.
- **Startup deliveries** still run. Artifact feedback saved before the crash (#873) and scheduled messages that came due start a turn at startup, which clears the mark. Each is something the developer asked for, and each starts at most one turn per thread.
- **The pull request watcher** holds its wakes for an interrupted thread, as it does for `limited` and `awaiting_approval`. Otherwise CI updates on 24 linked pull requests would start 24 turns within a minute and crash the machine again. `waitsOnDeveloper` in `domain.ts` names these three.
- **Sidebar and Inbox** treat an interrupted thread like `limited`: an attention row in Ready, never auto-settled or auto-archived by the idle timer, and settled by a merged pull request.
- **The CLI's `inbox`** lists an interrupted thread as an `interrupted` ask.

`specs/ThreadLifecycle.tla` gains an `interrupted` flag and a `Restart` action, which moves a busy thread to `idle` with the flag set. `InterruptedIsResting` checks that only a resting row carries it.

## Out of scope

- **Automatic resume.** The issue makes it optional. It needs a concurrency cap and a persisted one-attempt flag, and it would restart work the developer has not looked at. If it is wanted, it can build on `AgentRunner.resume` with a queue of at most three threads.
- **Resume all.** For the same reason, it would start every thread at once.
- **Detecting memory pressure** before the kernel kills the service.

## Open questions

- A capped "Resume all", for example three at a time.
- The phone's "Waiting on you" count leaves interrupted threads out, as it does `limited`, so it reads 0 after the OOM.
- A deliberate quit also shows "Stopped by a restart".
- A startup scheduled delivery or artifact feedback starts a turn without the `git status` preamble.
- The English resume prompt shows as a user message, and in a `chats` project with no repository it still asks the agent to run git.
- Interrupted threads are never auto-settled or auto-archived, same as `limited`.

## Verification

- `src/main/services/interruptedThreads.integration.test.ts` runs the app layer against one SQLite file:
  - It leaves 24 threads busy as a hard kill would, restarts, and checks that all 24 are interrupted and the provider started zero turns. Resuming one starts exactly one turn with the continuation prompt while the others stay interrupted. It disposes that app gracefully and starts a third, which resumes nothing.
  - A turn the developer stopped stays idle without the mark after a quit.
  - Resume refuses a thread that was not interrupted.
  - A crashed thread's queued message waits through the restart and the resumed turn, then starts.
  - A scheduled message that came due starts its own turn on an interrupted thread at startup, and clears the mark.
  - An interrupted thread from `threads.list` and from the `thread.updated` push decodes as `idle` with the `Thread` schema from before the column.
- Mutating the code proves the restart test bites: resetting to `idle`, dropping the shutdown flag, or forking a resume of every interrupted thread at startup (even three at a time) each fail it.
- `src/main/db/threadInterrupted.integration.test.ts` seeds a thread in every status with a snooze, runs migration 49, and checks that the rows are unchanged and `interrupted_at` is null.
- `InterruptedCallout.component.test.tsx` clicks Resume and checks the rpc and the refusal message. `ThreadNotices.component.test.tsx` checks the callout leaves after Resume.
- `PullRequestWatcher.delivery.integration.test.ts` checks that a watch wake waits for an interrupted thread.
- `pnpm check:specs ThreadLifecycle.cfg` and `ThreadLifecycle.Liveness.cfg`.
- With `verify-hinacode`, kill the app during a turn, launch again, and screenshot the sidebar row and the thread view. Click Resume and watch the thread run. Repeat on the phone's web build.
