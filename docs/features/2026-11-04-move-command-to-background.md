# Move a running command to the background

Status: Shipped
Date: 2026-11-04

## Problem

A Claude Code agent waits on each foreground `Bash` call. If a command hangs or runs long, the whole turn stalls, and today the only way out is Stop, which ends the turn too.

## User flow

A `Bash` row that has run for 3 seconds shows "Move to background", so quick commands never flash the button. Pressing it hands the agent a "running in the background" result, so the turn continues. The command keeps running and shows up in the background activity list, where it can be stopped.

## Design

`backgroundTasks.moveCommand` calls the optional `moveCommand` on the provider. Claude's calls `query.backgroundTasks(toolUseId)`, the SDK's equivalent of Ctrl+B, and the existing `backgroundTasks.changes` stream reports the new task. `providerInfo.movesCommandsToBackground` hides the button for the other agents.

## Out of scope

- Codex has no such request, and Muse moves a `bash` call to the background by itself after its `yield_time_ms`. opencode over ACP has no background work at all.
- Moving a command automatically after a time limit. The agent's own `run_in_background` and the Bash tool's timeout already cover commands the agent expects to be slow.

## Verification

`src/main/agents/claude/index.test.ts` and `MessagePart.component.test.tsx` cover the call and the button. Verified in the real app with a real Claude turn running `sleep`.
