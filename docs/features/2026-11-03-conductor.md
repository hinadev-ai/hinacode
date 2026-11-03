# Conductor

Status: Building
Date: 2026-11-03

## Problem

Running many threads means a lot of small chores: find the thread that works on an issue, check whether its pull request passed CI, start a new thread for a bug in another project. Each one starts with picking a project and a thread, which is the bookkeeping HinaCode is supposed to take off the user. There was no place to just say "send this bug to whatever is working on the sidebar" and let an agent do the routing.

## User flow

1. The sidebar has a **Conductor** row under the Inbox, Threads and Archived tabs. It is always there and shows the conductor's status like any thread row.
2. Clicking it opens the conductor, a thread with no project, branch or worktree. The user picks its agent and model in the composer as usual.
3. The user asks things like "what is still running?", "did the CI on the simulator PR pass?", "send this crash to the thread on the ports panel" or "start a thread in kkcode to fix the flaky e2e test". The conductor answers from the hinacode MCP tools and starts or steers threads in any project.
4. When the conversation gets long or stale, the user sends `/clear`. The conductor's messages and agent session are gone and the next message starts fresh.

## Design

- `thread.conductor` marks the conductor (migration `0039`, with a partial unique index so at most one row has it). It lives in the Chats project, so it works in its own `<dataDir>/chats/<threadId>` folder like any chat and needs no new workspace rules.
- `threads.conductor` returns the conductor, creating it on first call with the new-thread defaults. The sidebar row calls it on the first click, so a profile that never opens the conductor has no extra thread, and its row shows status only once the conductor exists. It routes to the client machine, so a desktop connected to clouds has one conductor, on the desktop.
- The renderer keeps the conductor in `byId` so it opens like any thread, but the list selectors leave it out of the Inbox, Pinned and project lists. It still counts toward the Dock badge. The breadcrumb shows its localized name, and `ThreadNaming` never renames it.
- `Threads.archive` leaves the conductor alone, so AutoArchive and the archive shortcuts cannot remove it.
- The conductor gets an extra `<conductor>` block in its instructions: find work with `list_threads` and `read_thread`, start work with `list_projects` and `create_thread`, prefer an existing thread over a new one, and do not edit project files itself.
- MCP thread tools keep writes inside the caller's project, except for the conductor:
  - `create_thread` takes `project`, an id from `list_projects`. The conductor must pass it, and any other thread is refused if it names another project.
  - `list_threads` lists every project's threads for the conductor, each with its `project`.
  - `send_to_thread` and `stop_thread` reach a thread of any project on this machine.
- `read_thread` now shows each linked pull request's state, checks, review and mergeability, fetched from GitHub when it is called. This helps every thread, and it is how the conductor answers CI questions without a separate tool.
- `/clear` is a composer command that only the conductor offers. It calls `threads.clear`, which refuses during a turn. Otherwise it closes the provider session the way an agent switch does, then deletes the messages and the session id in one transaction. Deleting the messages matters: with no session id, the runner would otherwise replay the history as a handoff prompt.

## Out of scope

- A conductor on a cloud. Clouds can still be reached through the threads that run there.
- Clearing other threads. `/clear` is only offered in the conductor.
- Scheduled check-ins. Watching a pull request already pings the thread that watches it.

## Verification

- `server.integration.test.ts` › conductor: lists every project's projects and threads, starts, steers and stops a thread in another project, refuses `project` from any other thread, and after `clear` the next turn has no resume id, no replayed history and the conductor's instructions.
- `Threads.integration.test.ts`: two concurrent `ensureConductor` calls make one conductor with a chat folder, archive leaves it, and its side chat is not a conductor.
- `stores/threads.test.ts`: the conductor opens and counts toward the badge but stays out of every list.
- `verify-hinacode`: on a fresh profile the sidebar shows Conductor. Opening it shows its breadcrumb without a project, and `/clear` empties the conversation.
