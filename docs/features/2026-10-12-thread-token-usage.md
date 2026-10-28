# Thread token usage

Status: Building
Date: 2026-10-12

## Problem

A developer running several agents can't see what a thread has spent. The per-turn `usage` the SDK reports leaves out work that happens outside the main loop, so it undercounts the threads that spend the most: sub-agents, and the workflow agents Claude Code starts in ultracode, which keep writing after the turn's result arrives.

## User flow

The total and its per-model breakdown were shown in a status bar along the bottom of the window. The status bar was removed on 2026-10-28 because it was mostly empty space, so nothing shows this number yet. `threads.usage` still answers for the next place that wants it.

## Design

The agents' own transcripts on disk are the source of truth. They are durable, and they include every sub-agent.

- Shape. `ThreadUsage { models: Array<ModelUsage>, transcripts }` in `src/shared/agent.ts`. `ModelUsage` holds `inputTokens` (uncached input only), `cacheWriteTokens`, `cacheReadTokens` and `outputTokens` (reasoning included), so the four parts add up to the total without double counting.
- `AgentProvider.usage(sessionId, home)` returns `ThreadUsage | null`. rpc `threads.usage({ threadId })` resolves the thread's provider, session and account home (`AgentAccounts.home`). A null home is the CLI's own, from `CLAUDE_CONFIG_DIR` or `CODEX_HOME` or their defaults.
- Claude. The session is `$CLAUDE_CONFIG_DIR/projects/*/<sessionId>.jsonl`, and its agents live under `<sessionId>/`, read recursively. Plain sub-agents sit in `subagents/`, but workflow agents sit one level deeper in `subagents/workflows/<run>/`, so a one-level read misses them. The CLI writes one line per content block, each repeating the message's usage, so lines are deduplicated by `message.id` and `requestId`. The output count grows across those lines, so the largest one wins. Synthetic messages are skipped.
- Codex. The thread is `$CODEX_HOME/sessions/**/rollout-*-<threadId>.jsonl`. Its sub-agents are other rollouts whose `session_meta.session_id` is the thread id. Newer rollouts write a `token_usage_record` per model response, keyed by `response_id`, and those are summed when present. Older rollouts only have `token_count.total_token_usage`, which is cumulative per rollout, repeats, and at times restarts from zero, so usage is the growth between consecutive totals. Totals leave out compaction requests, about 1% in long threads, which is why records win. Both are attributed to the model of the latest `turn_context`. OpenAI's `input_tokens` includes cached input, so cached tokens are subtracted, and `output_tokens` already includes reasoning.
- Each parsed file is memoized by path, size and mtime, one memo per home, so a refresh only re-reads the files that grew.

## Out of scope

- Cost. Transcripts carry no prices, and a price table is upkeep. On a subscription the number is notional anyway.
- Totals across threads, projects or days.
- Live counts inside a model request.

## Verification

- `transcripts.integration.test.ts` and `rollouts.integration.test.ts` run against fixture files that cover duplicate lines, a workflow agent two levels down, a forked Codex sub-agent and a repeated `token_count`.
- Run a Claude turn that spawns a sub-agent, then compare `threads.usage` with a script that sums the transcripts.
