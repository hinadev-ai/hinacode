# Compact remote events

Status: Building
Date: 2026-10-29

## Problem

The phone requests compact transcript pages but receives full tool inputs, outputs, and file diffs while a turn runs. The phone shows only tool summaries, statuses, and changed paths. These unused fields consume network bandwidth and remain in its message store until a reconnect replaces the history.

A synthetic stream of 20 tool calls and 100 text deltas contains 1,749,154 JSON bytes. Keeping the phone's displayed fields reduces it to 28,574 bytes. The probe uses the production schemas and Events layer. It does not measure a phone or relay.

## User flow

Pair and open a thread as before. Running turns show the same text, tool summaries, statuses, approvals, and changed paths with smaller live events. Desktop connections continue to receive complete events.

## Design

Add optional `compactEvents` to both `ClientFrame` auth variants. The mobile transport sends `true` with its proof and legacy token auth. The server validates the boolean and retains the choice for that authenticated socket. Absence and `false` preserve full events. Older servers accept and discard the additional auth field.

Project events only in the remote subscription. `message.created` and `message.updated` reuse `compactMessage`. Tool starts keep their summary input, tool completions keep `callId` and `isError` with an empty output, and file changes keep their path with an empty diff. Preserve event order, sequence numbers, and all other events. Reuse the compact transcript input summary logic.

Desktop window publication and desktop peers retain complete tool output. Authentication proofs, token rotation, mutation deduplication, and protocol version stay the same because the option is additive.

## Out of scope

Thread subscriptions, delta batching, database pagination, reconnect policy, and network timing changes. The server still reads an entire transcript before selecting a compact page.

## Verification

Use the real remote listener integration fixture to connect a compact client beside clients with omitted and false options. Publish identical tool, text, and message events. Confirm only the opted-in socket loses undisplayed fields, including for proof auth. Check that desktop pushes remain complete. Schema tests reject non-boolean options, and mobile transport tests cover both auth paths.

Rerun `.context/perf/remote-audit.ts` to compare event bytes and encoding costs on synthetic data. Real phone render and radio performance still need a Release app capture through `profile-hinacode`.
