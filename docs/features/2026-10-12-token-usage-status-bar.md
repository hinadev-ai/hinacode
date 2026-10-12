# Token usage status bar

Status: Building
Date: 2026-10-12

## Problem

A developer running several agents can't see what a thread has spent. The per-turn `usage` the SDK reports leaves out work that happens outside the main loop, so it undercounts the threads that spend the most: sub-agents, and the workflow agents Claude Code starts in ultracode, which keep writing after the turn's result arrives.

## User flow

1. A status bar runs along the bottom of the window, like the one in VS Code.
2. On a thread with a session, its right side shows the thread's total tokens, such as "1.2M tokens".
3. Hovering or focusing the item shows a breakdown per model (input, cache write, cache read, output) and how many transcripts it counted, such as "Main session and 4 sub-agents".
4. The number refreshes when a turn ends, when a sub-agent changes, and every few seconds while the thread runs.
5. A thread without a session, or one whose transcript is gone, shows no item.

## Design

The agents' own transcripts on disk are the source of truth. They are durable, and they include every sub-agent.

- Shape. `ThreadUsage { models: Array<ModelUsage>, transcripts }` in `src/shared/agent.ts`. `ModelUsage` holds `inputTokens` (uncached input only), `cacheWriteTokens`, `cacheReadTokens` and `outputTokens` (reasoning included), so the four parts add up to the total without double counting.
- `AgentProvider.usage(sessionId)` returns `ThreadUsage | null`. rpc `threads.usage({ threadId })` resolves the thread's provider and session.
- Claude. The session is `$CLAUDE_CONFIG_DIR/projects/*/<sessionId>.jsonl`, and its agents live under `<sessionId>/`, read recursively. Plain sub-agents sit in `subagents/`, but workflow agents sit one level deeper in `subagents/workflows/<run>/`, so a one-level read misses them. The CLI writes one line per content block, each repeating the message's usage, so lines are deduplicated by `message.id` and `requestId`. The output count grows across those lines, so the largest one wins. Synthetic messages are skipped.
- Codex. The thread is `$CODEX_HOME/sessions/**/rollout-*-<threadId>.jsonl`. Its sub-agents are other rollouts whose `session_meta.session_id` is the thread id. Newer rollouts write a `token_usage_record` per model response, keyed by `response_id`, and those are summed when present. Older rollouts only have `token_count.total_token_usage`, which is cumulative per rollout, repeats, and at times restarts from zero, so usage is the growth between consecutive totals. Totals leave out compaction requests, about 1% in long threads, which is why records win. Both are attributed to the model of the latest `turn_context`. OpenAI's `input_tokens` includes cached input, so cached tokens are subtracted, and `output_tokens` already includes reasoning.
- Each parsed file is memoized by path, size and mtime, so a refresh only re-reads the files that grew.
- Renderer. `StatusBar` sits at the bottom of `AppShell`, full width. `ThreadTokens` is a focusable item with a tooltip.

## Out of scope

- Cost. Transcripts carry no prices, and a price table is upkeep. On a subscription the number is notional anyway.
- Totals across threads, projects or days.
- Live counts inside a model request.

## Verification

- `transcripts.integration.test.ts` and `rollouts.integration.test.ts` run against fixture files that cover duplicate lines, a workflow agent two levels down, a forked Codex sub-agent and a repeated `token_count`.
- With `verify-kkcode`: run a Claude turn that spawns a sub-agent, then compare the hover breakdown with a script that sums the transcripts. Check both themes.
