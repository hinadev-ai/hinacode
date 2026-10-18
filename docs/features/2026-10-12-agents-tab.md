# Agents tab

Status: Shipped
Date: 2026-10-12

## Problem

Claude Code and Codex both fan work out to sub-agents. hinacode showed only the parent's `Agent` tool call with a spinner, so while a turn waited on its sub-agents the developer could not tell what each one was doing, how far along it was, or whether one had failed.

## User flow

1. Open a thread. The details panel has two tabs, Details (workspace, setup log, changes, ports, pull requests) and Agents.
2. When the agent spawns sub-agents, the Agents tab shows a count of the running ones.
3. Agents lists them newest first: a status icon, the provider icon and its task, a line with the latest progress summary (or its last tool), and `tools · tokens · elapsed`, with elapsed counting up while it runs.
4. When a sub-agent ends, the row keeps its final summary and stats.
5. While sub-agents run, a bar above the composer shows how many are running and a chip per sub-agent in the batch.
6. A row, a chip, or the `Agent` tool call in the transcript opens the sub-agent's own view: its prompt, the tool calls it made, and its result. The back button returns to the thread, or to the parent sub-agent for a nested one. The thread's transcript no longer shows a sub-agent's tool calls.

The tabs follow the Base UI tabs keyboard model: arrow keys move between them.

## Design

- `Subagent` and the `subagent_updated` event live in `src/shared/agent.ts`. The event carries the sub-agent's full state, so consumers replace instead of merging.
- Claude (`agents/claude/mapMessage.ts`): `task_started` for `local_agent` tasks starts a row, `task_progress` updates counts, last tool and summary, and `task_notification` sets the final status and summary. Ambient and `skip_transcript` tasks, background shells and monitors are not sub-agents. `agentProgressSummaries` is on, so long runs get a short "what it is doing" line. A background sub-agent can outlive Claude's reply, so the turn stays open until the CLI reports idle (see `docs/arch.md`).
- Codex (`agents/codex/subagents.ts`): `subAgentActivity` items start and end a row, keyed by the sub-agent's Codex thread id. Notifications from that child thread give tool calls, token usage and its final answer. `agentsStates` on collab tool calls update status and message.
- `AgentRunner` keeps the latest sub-agent per id per thread in memory, pushes `thread.subagents` with the whole list on every change, and answers `subagents.list`. `subagent_updated` never reaches the transcript.
- A sub-agent's tool calls do reach the transcript, tagged with `parentCallId`. `Subagent.callId` is the value they carry: the spawning `Agent` call on Claude, the child thread id on Codex. The thread route's `agent` search param holds it, and `lib/subagents.ts` collects the sub-agent's calls from the transcript, so a Claude sub-agent's view survives a restart.
- The renderer's `stores/subagents.ts` loads through the rpc and replaces on each push, like pull request links.
- Running uses the `--working` token (brand violet). Completed and stopped stay muted, failed is red. The spinner stops under reduced motion.

## Out of scope

- Persistence. Sub-agents last until the app restarts. History is in the transcript's `Agent` tool calls.
- A sub-agent's own text between tool calls. Its view shows the prompt, the calls and the final result.
- Steering a single sub-agent. The composer in a sub-agent's view still steers the thread's agent.
- Codex sub-agent approvals. Requests from a child thread are still not routed to the approval UI.

## Verification

- `agents/claude/mapMessage.test.ts` and `agents/codex/subagents.test.ts` map recorded SDK and app-server messages.
- `ipc.integration.test.ts` runs a scripted provider through the real `AgentRunner` and checks `subagents.list`, the `thread.subagents` pushes, and that the transcript gets no sub-agent events.
- In the app: a Claude Haiku turn that spawns two parallel sub-agents, and a Codex turn that spawns one. Screenshot the Agents tab while they run and after.
