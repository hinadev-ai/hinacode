# Auto-compact threshold

Status: Shipped
Date: 2026-10-22

## Problem

Each agent compacts a full conversation by itself, but only at its own threshold. Claude Code on a 1M model waits until about 967K tokens, so a long thread gets slower and more expensive on every message long before that. The CLI lets a developer move the threshold with `/autocompact` or `autoCompactWindow`, Codex with `model_auto_compact_token_limit`, and Muse Code not at all. HinaCode exposed none of them, so the only way was to edit each CLI's config files by hand.

## User flow

1. In Settings, Models, each agent has an "Auto-compact at" field. It is empty, which keeps the agent's own threshold.
2. The developer types `300` (thousands of tokens) and saves. The field accepts 100 to 1000.
3. The next message on any thread of that agent runs with the new threshold. When the context reaches it, the transcript shows "Compacting the conversation…" and then "Conversation compacted automatically", as it does for Claude today.
4. "Use agent default" clears the field and goes back to the agent's own threshold.

## Design

- `Settings.autoCompactTokens` holds `{ claude, codex, muse }`, each a token count from 100,000 to 1,000,000 or null. The range is Claude Code's, which ignores a window outside it. A row saved before the key existed decodes to all null.
- `AgentRunner` reads the setting on every turn and passes `RunTurnInput.autoCompactTokens` to the provider. Each provider uses its agent's own mechanism:
  - Claude gets `autoCompactWindow` in the flag settings layer, which outranks the user's own `/autocompact`. The CLI reads it once per process, and `applyFlagSettings` does not change it on a live session, so a changed value starts a new process that resumes the session, as a changed skill set does. Claude keeps room for the summary, so it compacts about 33K before the window (117K for a 150K window).
  - Codex gets `model_auto_compact_token_limit` in the `thread/start` and `thread/resume` config. Codex compacts at the start of the turn that would pass it. The app-server ignores `thread/resume` config for a thread it has loaded, so when the threshold changes the provider sends `thread/unsubscribe` first and the resume loads the thread again. Its `contextCompaction` items now map to `compaction_updated`. They carry no token counts, so `Compaction.done.preTokens` is nullable and the rule shows no sizes.
  - Muse Code has no threshold setting on the wire. The host listener tracks each session's last `session/contextUsage`, and a session resumed into a fresh host reads it backward from `view/page`. When it is at or past the threshold, the provider sends `session/compact` and waits for the `compaction` item before `turn/start`, because Muse rejects a turn during a compaction with `runtime_busy`. Muse has no call that cancels a compaction, so after a Stop mid-compaction the next turn waits for it to finish. Muse `compaction` items now map to `compaction_updated`, so Muse's own automatic compaction shows up too.
- No migration: settings are JSON rows, and transcript parts are JSON.

## Out of scope

- A per-model threshold. Claude Code supports one in `modelSettings`, but an agent's models mostly share a window size, and one field per agent is enough until someone asks.
- Turning compaction off. Every agent fails the turn once the window overflows, so off is never what the developer wants.
- Marking the threshold on the context ring.

## Verification

- `claude/index.test.ts`: a changed threshold resumes the session in a new CLI with `autoCompactWindow`.
- `codex/index.integration.test.ts`: the threshold reaches `thread/start` config, a changed threshold unloads the thread before resuming it, and a `contextCompaction` item shows as running then done.
- `muse/index.integration.test.ts`, against the real `muse` binary: a session past the threshold compacts before the next turn's reply, also right after a resume into a fresh host, and a turn after a Stop mid-compaction waits for it and then replies.
- A probe against the real Claude CLI read `autoCompactThreshold` from `getContextUsage()`. A real `codex exec -c model_auto_compact_token_limit=3000` compacted at the start of its second turn.
- With `verify-hinacode`: set and clear the field in Settings, Models, and check the saved value with `settings.get`.
