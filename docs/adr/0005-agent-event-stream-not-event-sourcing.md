# 0005. One AgentEvent stream, folded into messages, not event-sourced

Status: Accepted
Date: 2026-10-11

## Context

Claude (Agent SDK) and Codex (app-server JSON-RPC) speak different protocols. t3code keeps an event-sourced orchestrator in front of them. We need both agents in one transcript, and a restart must not lose that transcript.

## Decision

- Each provider implements `AgentProvider` and translates its protocol into one `AgentEvent` union.
- A pure `foldEvent` in `src/shared` turns events into message parts, and both main and the renderer use it.
- `AgentRunner` saves changed messages at most every 500 ms and once more when a turn ends. Thread status is a column, not a projection.
- On boot, anything left running is marked over.
- The transcript snapshot overlays the in-memory turn and returns a `seq`. The renderer buffers pushes during the load and applies only those with a higher `seq`. A per-thread lock means a snapshot never contains a change without the push that announced it.

## Consequences

- Both providers were built in parallel against the interface. A third agent is one more implementation.
- No replay, no projections, no event table. We give up time-travel debugging and rebuilding views from history.
- A crash can lose up to 500 ms of streamed text.
