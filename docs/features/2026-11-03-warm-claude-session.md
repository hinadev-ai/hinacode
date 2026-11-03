# Warm the Claude session while the user types

Status: Shipped
Date: 2026-11-03

## Problem

A Claude Code thread keeps its CLI alive for 60 idle seconds after a turn. Every other send starts a new CLI: the first message of a thread, and any message after a minute away. The CLI loads the user's settings, MCP servers, hooks and `CLAUDE.md` before it reports `system/init`, and that takes about 1.2 seconds on the dev VM. The user waits through it after pressing Send, on top of the model's own time to first token.

The rest of the path is short. Measured from Enter, the user message and the Thinking line render within 70 ms, and a 100,000-file repository adds about 120 ms of `git add -A` for the turn snapshot. Codex binds a turn in under 150 ms because it shares one `codex app-server`.

## User flow

1. The user opens a thread and starts typing.
2. The first character in an empty composer starts the thread's Claude session in the background. Nothing on screen changes.
3. The user presses Send. The prompt goes to a CLI that has already booted, so the reply starts as soon as the model answers.

A message typed in under a second, or pasted and sent at once, gains only the part of the boot that overlapped. A user who types and leaves the message unsent for 60 seconds finds the session closed again, as it is today.

## Design

- `threads.warm { threadId }` is a new rpc. The composer calls it when its text goes from empty to non-empty. It skips busy threads, sidechats, and unstarted threads with a pending worktree or branch choice, because those change the working directory or branch at send time.
- `AgentRunner.warm` builds the same `SessionInput` a send would build, with the same `sessionInput` helper that `makeTurn` uses, and hands it to `AgentProvider.warm`. It skips threads with a turn running or pending, archived threads, and a sidechat's first send, which rebases the thread onto its parent first. It logs and swallows every failure, so a warm can never surface an error.
- `AgentProvider.warm` is optional. Only Claude implements it. It starts or reuses the session through the same `acquireSession` a turn uses, then releases it. Releasing arms the existing 60-second idle expiry, so an unused warm session closes itself, and a warm on a live idle session restarts its countdown.
- A turn finds the warm session through the existing reuse check (`sameContext`: working directory, account and instructions). Session acquisition is serialized per thread, so a warm and a send that arrive together start one CLI, not two.

The Agent SDK also has `startup()` and an alpha `prewarm()`. Neither fits better. `startup()` saves only the spawn. A `prewarm()` spare fixes its MCP servers and `canUseTool` at prewarm time, and HinaCode gives each thread its own MCP credential and approval callbacks, so a spare cannot serve more than one thread. Starting the thread's own streaming `query()` early does what `startup()` does and reuses the idle-session code that already exists.

## Out of scope

- Streaming reply text again. `ReplyText` holds a text block until it is complete, which costs 2.7 s (Claude) to 5.5 s (Codex) on a 200-word reply. That reverses a deliberate choice, so it is a separate decision.
- A longer or adaptive idle TTL. A parked CLI holds about 250 MB, and warming on intent covers the idle case without keeping more processes alive.
- Warming on thread open or composer focus. Browsing threads would start CLIs nobody uses.
- Codex, Muse Code and opencode, which bind a turn in under 150 ms already.

## Verification

`node scripts/perf/first-response.ts suite <port> <label> <projectId>` drives the real composer over CDP and records each milestone from Enter. See [`scripts/perf/README.md`](../../scripts/perf/README.md#time-to-first-response). Tests: `src/main/agents/claude/index.test.ts` ("Claude warm sessions") and `src/main/services/AgentRunner.integration.test.ts` ("warms the session with the same input the next send runs its turn with").
