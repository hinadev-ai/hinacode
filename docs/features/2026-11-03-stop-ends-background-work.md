# Stop ends the thread's background work, except its shells

Status: Shipped
Date: 2026-11-03

## Problem

Stop only interrupts the running turn. The turn's end stops `run_agent` runs, but the rest of what the turn started keeps going: background shells and workflows, a wakeup scheduled for a later turn, and sub-agents the agent spawned with its own tool. Those sub-agents could show as stopped while they kept working, until [sub-agents that outlive their turn](2026-11-04-subagents-between-turns.md) let a row follow its provider. The user presses Stop to make the thread quiet, then finds a `/loop` that wakes the thread again ten minutes later. Each item has its own stop control in the Activity panel, except the wakeup, which has none.

## User flow

1. A turn runs, and it has started background tasks, sub-agents or a wakeup.
2. The user presses Stop, or presses the interrupt shortcut. Another agent's `stop_thread` call does the same.
3. The turn ends as it does today. The thread's running sub-agents show as stopped, its background workflows leave the Activity panel, and a pending wakeup is gone, so the thread stays idle. Background shells keep running with their own stop controls, because Stop usually redirects the agent and a dev server should survive that.

## Design

`AgentRunner.interrupt` interrupts the turn as before, then stops what the thread left running:

- Every running sub-agent in the thread's list, through the existing `stopSubagent`. That covers `run_agent` runs, which `AgentRunner` stops itself, and the provider's own sub-agents through `AgentProvider.stopSubagent`.
- Every background task except a shell or a wakeup, through the existing `stopBackgroundTask`, which calls `AgentProvider.backgroundTasks.stop`.
- A pending wakeup. Claude Code has no call that cancels one, so the runner closes the provider session with `closeSession`, the way switching agents retires a session. It waits for the interrupted turn to finish first, and skips the close if a new turn has started by then. The next message resumes the session from its id, so the conversation carries on. Only session approvals are lost, as they are after the session's idle timeout.

Closing the session only when a wakeup is pending keeps a plain Stop cheap: the warm Claude session survives, and the next message does not wait for a new CLI.

Each stop is best effort. A provider that cannot stop one item does not keep Stop from ending the others.

## Out of scope

- **Other processes.** A dev server started with `pnpm dev &` inside a normal shell call is not a tracked background task. The Ports panel already lists and stops those. Killing every process under the agent would also kill the CLI's own MCP servers.
- **Idle threads.** The Stop button still shows only while a turn runs. Background work left on an idle thread keeps its controls in the Activity panel.

## Verification

- `AgentRunner.integration.test.ts`: Stop during a turn stops the thread's running sub-agents and workflows, keeps its shells, and closes the session only when a wakeup is pending.
- With `verify-hinacode`, start a Claude turn that runs `sleep 600` in the background and schedules a wakeup, press Stop, and check that the shell stays in the Activity panel and no turn starts when the wakeup was due.
