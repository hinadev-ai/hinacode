# Context window ring

Status: Building
Date: 2026-10-12

## Problem

A long thread fills the model's context window until the agent compacts or degrades. Today a developer can't see how close a thread is without running `/context` in a CLI, so they find out late and start a fresh thread after quality has already dropped.

## User flow

1. After a turn completes, a small ring appears in the composer controls, left of Send.
2. The ring fills with the share of the context window used. At 80% or more it turns amber.
3. Hovering it, or tabbing to it, shows "Context window", the percentage, "84K / 200K tokens" and "As of the last turn".
4. A new thread, or one whose agent never reported a context window, shows no ring.

## Design

- `ContextWindow { usedTokens, maxTokens }` rides on `TokenUsage.context` in `turn_completed`. `foldEvent` already stores usage in `message.usage` (JSON), so there is no migration, and older rows decode without `context`.
- Claude: `mapMessage` remembers the main loop's latest assistant message (model plus input, cache and output tokens). Subagent messages are ignored. The result's `modelUsage[model].contextWindow` supplies the maximum. The value resets each turn.
- Codex: `thread/tokenUsage/updated` carries `last.totalTokens` and `modelContextWindow`. The latest one of the turn wins.
- Renderer: `ContextRing` selects the newest assistant message with `usage.context` from `useMessages`. It is a `role="meter"` with a value text, wrapped in the shared tooltip.

## Out of scope

- Live updates during a running turn. The ring updates when each turn completes.
- A per-category breakdown like Claude's `/context`.
- Compaction controls.

## Verification

- `mapMessage.test.ts` covers main versus subagent usage and a missing `modelUsage` entry. `codex/index.integration.test.ts` covers the Codex path through the fake app-server.
- With `verify-hinacode`: run one turn in a Claude thread and one in a Codex thread, check that the ring appears, then hover and focus it and compare the tooltip with the numbers. Check both themes.
