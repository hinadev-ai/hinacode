# Sub-agents that outlive their turn

Status: Shipped
Date: 2026-11-04

## Problem

Codex lets an agent spawn a sub-agent with `spawn_agent` and end its turn without waiting. The sub-agent keeps working, but HinaCode read its updates only inside the parent's turn. When the turn ended, the runner marked every running row stopped, so the Agents tab said "stopped" while the sub-agent was still working. When it finished, nobody heard it: the row never changed, and the parent agent never saw the reply it had asked for.

Claude does not hit this, because its turn stays open until its background agents report back.

## User flow

1. A Codex agent spawns a sub-agent, does not wait for it, and ends its turn. The thread goes idle, and the sub-agent's row in the Agents tab stays running, with its last tool and token count still updating.
2. The sub-agent finishes or fails. Its row shows that, with its reply.
3. HinaCode hands the reply to the parent: if the thread is idle, a new turn starts with a message that names the sub-agent and quotes its reply. If a turn is running, the message is steered into it. The parent picks up where the sub-agent left off.
4. Stopping the row still works after the parent turn has ended, and a sub-agent the user stopped does not wake the thread.

## Design

- `AgentProvider.subagentChanges` is an optional stream of `{ threadId, subagent }`, for providers that can report a sub-agent between turns. It sits next to `backgroundTasks.changes` and works the same way: the runner records each change and pushes `thread.subagents`.
- **A row stays running only while something can still update it.** At the end of a turn the runner marks running rows stopped only when the provider has no `subagentChanges`. When HinaCode closes a provider session itself, on an agent switch or when Stop retires a pending wakeup, it marks the rows stopped, because the session that could report them is gone.
- **Codex.** Each `codex app-server` client gets one listener for its lifetime. While the parent thread has a turn, the turn's own handler reads the sub-agent's notifications as before. Once the parent is idle, the listener takes over: it maps the child thread's `turn/started` and `turn/completed` to running, completed, stopped or failed, and keeps applying its tool, token and reply updates. It remembers which client owns each child, so `stopSubagent` can interrupt the child's turn after the parent's turn has ended.
- **Handing the reply back.** When a change moves a row from running to completed or failed, the runner calls `steerWhen` with `subagentReport` (`agents/subagentReport.ts`), the same path pull request watches use to wake a thread. The message quotes the reply, so the parent does not spend a tool call to read it. It is delivered only if the thread is idle or running and still on the provider that ran the sub-agent: an archived, rate-limited or waiting thread, or one that switched agents, is left alone. Several sub-agents finishing together start one turn and steer the rest into it.
- A stopped row never wakes the thread. The user, or the parent, ended it on purpose.

## Out of scope

- Muse and opencode report sub-agents only inside a turn, so their rows keep the old turn-end marking. Muse's turn waits for its sub-agents, like Claude's.
- Rows live in memory. After a restart, a sub-agent that was still running is no longer listed.

## Verification

- `services/AgentRunner.integration.test.ts`: a row stays running after its turn ends, a later completion updates it and starts a turn whose prompt carries the reply, a stopped report wakes nothing, a provider without `subagentChanges` keeps the turn-end marking, and switching agents marks leftover rows stopped.
- `agents/codex/index.integration.test.ts`: the fake app server finishes a sub-agent after its parent turn has ended, and the provider reports it completed with its reply. Stopping a sub-agent after the parent turn interrupts the child's turn and reports it stopped.
- With `verify-hinacode`, a Codex thread spawns a two-minute sub-agent without waiting. The row stays running while the thread is idle, turns completed when the sub-agent finishes, and the thread wakes with the reply.
