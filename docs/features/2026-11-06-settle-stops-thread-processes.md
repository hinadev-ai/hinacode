# Settle stops the thread's processes

Status: Shipped
Date: 2026-11-06

## Problem

Settle only moves a thread into the Settled group. Everything the thread started keeps running: the dev server on port 5173, a background shell, a workflow, a wakeup that starts a new turn tomorrow, the terminals in its drawer and the warm agent CLI. A developer who settles ten threads at the end of the day still has ten dev servers holding ports and memory. Auto-settle on merge has the same gap, and it also settles a thread while a background task is still working on it.

## User flow

1. **Manual.** The developer settles an idle thread from the sidebar. HinaCode stops the thread's sub-agents and background tasks, shells included, closes its agent session, closes its terminals and stops every process listening on a port in its workspace. Then the thread moves to Settled. Undo moves it back but does not restart anything.
2. **On merge.** With "Settle when merged" on, the sweep settles a thread once its pull requests are finished and one of its own merged, as before. It now also waits until the thread is quiet: no turn running, no running sub-agent, no background task and no listening port. Then it settles the thread and cleans up the same way. A thread with a dev server still up stays in Ready until the developer stops it or settles it by hand.

## Design

A thread's leftover work, and what settling does with each:

| Work                                     | Blocks auto-settle | On settle                                             |
| ---------------------------------------- | ------------------ | ----------------------------------------------------- |
| Turn running                             | yes                | manual settle refuses, as before                      |
| Running sub-agent                        | yes                | `AgentRunner.stopSubagent`                            |
| Background task (shell, workflow, other) | yes                | `AgentProvider.backgroundTasks.stop`                  |
| Wakeup                                   | yes                | closed with the session                               |
| Agent session                            | no                 | `AgentProvider.closeSession`                          |
| Terminal                                 | no                 | `Terminals.closeThread`                               |
| Listening port                           | yes                | `Ports.closeThread`: SIGTERM, SIGKILL after 3 seconds |

The `Settle` service, formerly `AutoSettle`, owns both paths and runs one `release` for each. `release` stops the agent's work first through `AgentRunner.release`, because `Ports` counts every descendant of the agent CLI as the thread's and the CLI's own MCP servers should exit with the CLI rather than be killed under a live session. Then it closes terminals, whose hangup ends most dev servers. Then `Ports.closeThread` stops whatever still listens. Each step is best effort, so a provider that cannot stop one task does not keep the thread from settling.

`AgentRunner.release` closes the session only while no turn holds the thread, under the same per-thread lock that sends use, and keeps that lock while the caller's cleanup runs: closing terminals, stopping listeners and marking the thread settled. A send that arrives during cleanup waits for it, so cleanup never stops a process the new turn started. When a turn started before the lock was taken, `release` stops there and leaves the terminals and listeners to that turn, and a manual settle fails as busy. The next message resumes the session from its id. Closing a Codex session also unsubscribes its thread from the shared app-server, so an idle thread does not stay loaded there.

A merge that removes the thread's worktree releases the agent and terminals but does not scan ports again, because the sweep has just found no listener in the worktree. Once a thread's worktree is removed, `Ports` resolves the thread to the project root, where another thread or the developer may run a dev server. So `Ports.closeThread` stops only the agent's descendants for such a thread and never matches by directory, whoever calls it.

A port scan that fails, for example on a machine without `ss`, leaves the thread in Ready. An unknown listener state is not quiet. A project folder that no longer exists counts as having no listeners.

The sweep checks the in-memory parts of "quiet" and the pull requests before it scans ports, so it runs `ss` or `lsof` only for a thread that is otherwise ready to settle.

## Out of scope

- **Processes that do not listen.** A file watcher started with `&` in the worktree has no port, so neither path finds it. Closing the terminals and the agent session ends the ones they own.
- **Archive.** Archiving still only closes terminals. It can call the same `release` if that turns out to matter.

## Verification

- `Settle.integration.test.ts`: manual settle stops a real listener in the thread's workspace, closes its terminals and releases the agent. The sweep leaves a merged thread alone while it has a background task, a running sub-agent or a listener, and settles and releases it once it is quiet.
- `Settle.integration.test.ts` also covers a turn that starts while a thread settles, a merge that removes the worktree next to a project-root dev server, and a port scan that fails.
- `codex/index.integration.test.ts`: closing an idle Codex session unsubscribes its thread once.
- `AgentRunner.integration.test.ts`: `release` stops sub-agents and every task, shells included, and closes the session, and leaves a session that a turn holds open.
