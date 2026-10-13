# Worked for

Status: Shipped
Date: 2026-10-12

## Problem

Developers returning to a finished response cannot see how long it took. The elapsed-time row should provide that information while keeping the response's activity visible.

## User flow

While the agent runs, its activity stays visible. When an assistant response completes, a quiet `Worked for 08:05` row appears above its activity and answer. The row is plain text, with no arrow or collapse action. Reasoning, tool calls, file changes, questions, attachments, and progress messages retain their existing order and controls.

Text-only responses show the same elapsed-time row. Find in thread searches visible progress and reveals matching command details through their existing controls.

## Design

`Message.createdAt` and `Message.completedAt` already persist in SQLite. Their difference supplies elapsed wall time, including approval waits. Each steer ends one assistant response and begins another, so each response segment has its own duration. This does not claim to time a whole provider turn across steers.

The renderer derives an `AssistantPresentation` union. Both variants hold indexed visible `parts`. `completed` adds `durationMs`; `inline` has no elapsed-time row. Original part indices preserve React keys, command grouping, and find targets. There is no work/reply partition or disclosure state. Nested subagent calls remain in the subagent view. Synthetic subagent transcripts keep their existing rendering.

No migration, RPC method, provider event, or new trust boundary is needed. Invalid or reversed timestamps retain the existing inline rendering. Empty closed messages stay hidden. Duration uses `mm:ss`, or `h:mm:ss` above an hour. Theme tokens support both themes. The elapsed-time row has no animation or interaction state.

## Out of scope

Live timers, provider CPU time, and timing a whole run across steers. A response recovered after an unclean shutdown uses the existing completion timestamp, which can include time the app was closed.

## Verification

Pure tests cover original part order, completion timing, questions, nested calls, and duration formatting. Electron acceptance scenarios exercise the static row, visible activity, tool output, find, restart, and both themes. The existing streaming scenarios also check that finished text, tool output, and errors survive the completion boundary.

The original isolated native Electron run on macOS checked a real Codex command and persisted duration across restart in Traditional Chinese. The revised row uses the same timestamps and renderer helper. Its native Electron verification seeds a completed response and captures `.context/shots/worked-for-static-dark.png` and `worked-for-static-light.png`, with activity visible and no arrow or collapse control. The Linux Xvfb helper is unavailable on this host, so verification uses isolated native Electron profiles.

Live verification covers Codex. Claude, steering, and approval waits use the same tested renderer helper, but were not driven with paid agent turns. Recovery after an unclean shutdown retains the timestamp limitation described above.

Checkpoints are the presentation tests, renderer typecheck and lint, the Electron acceptance suite, then native screenshots. Required final checks are `pnpm typecheck`, `pnpm lint`, and `pnpm test`.

Checks use the canonical macOS temporary path. The unit and integration suite runs with `--maxWorkers=2`; Electron runs with `--workers=2 --retries=1`.
