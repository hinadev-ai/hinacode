# Context compaction

Status: Shipped
Date: 2026-10-20

## Problem

Claude Code summarizes a long conversation to free its context window, either on `/compact` or on its own as the window fills. HinaCode dropped every signal of it. A `/compact` turn showed an empty reply after a pause of up to a minute, an automatic compaction mid-turn was invisible, and the context ring kept showing the size from before the summary.

## User flow

1. The developer sends `/compact`, or a turn fills the window and Claude compacts by itself.
2. While Claude summarizes, the transcript shows a rule with a spinner, "Compacting the conversation…".
3. When it finishes, the rule reads "Conversation compacted" (or "compacted automatically") with the size before and after, such as "31K → 2.3K tokens". Everything above the rule now reaches the agent only as the summary.
4. The context ring drops to the size after the summary.
5. If compaction fails, the rule shows "Compaction failed" and Claude's reason, such as "Not enough messages to compact."

## Design

- `Compaction` in `src/shared/agent.ts` is `running`, `done { trigger, preTokens, postTokens }` or `failed { message }`. The `compaction_updated` event carries the full state, and `foldEvent` replaces the running `compaction` part or appends a new one. A turn that ends mid-compaction fails it, like a running tool call. Parts are JSON, so there is no migration.
- Claude sends `status: "compacting"`, then `status: null` with `compact_result`, then `compact_boundary` with `compact_metadata`. `mapMessage` maps the first to `running`, a failed `compact_result` to `failed`, and the boundary to `done`.
- A `/compact` turn makes no model request, so it reports no `usage.context`. `ContextRing` takes `postTokens` from a later compaction and keeps the maximum from the turn before.
- The phone shows one line of text per state. The MCP `read_thread` tool renders `[context compaction: done]`.

## Out of scope

- Codex compaction (`contextCompaction` items). The shape is provider neutral, so Codex can emit the same event later.
- Settings for the auto-compact window or for turning compaction off. Claude Code already reads `autoCompactWindow` and `autoCompactEnabled` from the settings files HinaCode loads.
- Marking the auto-compact threshold on the context ring.

## Verification

- `mapMessage.test.ts` replays the message sequence a real `/compact` sent. `foldEvent.test.ts` covers replacing the running part and failing it when the turn ends.
- With `verify-hinacode`: in a Claude thread, send two one-line prompts, then `/compact`. Check the running rule, the finished rule with token counts, the transcript from `threads.transcript`, and that the ring reads the size after the summary.
