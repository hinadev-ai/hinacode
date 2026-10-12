# Limited threads

Status: Building
Date: 2026-10-12

## Problem

A developer whose Claude account has exhausted its usage sees an idle thread after the error. The sidebar gives no reason the agent stopped.

## User flow

Claude rejects a turn because of a usage limit. The sidebar and thread header show an amber Limited label. A callout preserves the provider's explanation. When Claude supplies a reset timestamp, Resume at reset schedules one retry of the last prompt and attachments. Cancel automatic resume removes the schedule. Both actions work with the keyboard. The schedule survives restart and runs while kkcode is open. If the reset passed while the app was closed, the retry runs after startup.

An organization monthly spend cap gets its own callout with the `/usage-credits` instruction. Its message may mention a session reset, which does not clear the organization cap. This case has no automatic resume action. The composer remains available for a manual attempt. Sending again moves the thread to Running. A successful retry returns it to Idle.

## Design

`ThreadStatus` gains `limited`. The terminal event `turn_limited` carries a `UsageLimit` union. A usage limit has a message and an optional reset containing an ISO timestamp and `autoResume` flag. An organization spend limit has only a message, so it cannot carry a schedule. The Claude mapper records structured limit signals for the current turn and classifies the final result. Warnings and successful turns do not become limited. Known limit error text handles CLI versions without the structured signal.

The runner persists `limited` and its limit metadata through cleanup and restart. Migration 6 replaces the status column in place and adds `usage_limit` JSON, preserving related messages, pull request links, and automation runs. The existing schema-decoded channels carry the variants. `threads.resumeAtReset` accepts only a thread id and an enable flag. Main refuses scheduling without a provider-confirmed usage reset. A scoped runner fiber checks due requests each second and consumes them before sending, so a failed start does not create a retry loop.

The simulation replaces the Claude provider with typed SDK fixtures passed through the production mapper and disables model-based thread naming. `KKCODE_MOCK_CLAUDE=usage-limit` or `org-spend-limit` requires an explicit `KKCODE_USER_DATA` directory. The first attempt in each thread is limited; subsequent attempts and resumed sessions succeed. `KKCODE_MOCK_RESET_MS` controls the usage reset delay, defaulting to 60000. No Claude account calls are made by the simulation.

## Out of scope

No account-wide blocking, repeated automatic retries, or reset-time parsing from prose. Limits can differ by model and may reset or be raised externally. Unknown reset times require a manual attempt.

## Verification

Check Claude message mapping, migration preservation, and the runner through real SQLite and RPC. Drive Send in an isolated Electron instance with the simulation, inspect the sidebar and header in both themes and languages, restart to prove persistence, then retry to prove recovery. Save screenshots in `.context/shots/`.
